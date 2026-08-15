import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createGatewayHttpServer } from "../src/http-server.js";
import type { Logger } from "../src/logger.js";
import type { MemoryService } from "../src/memory-service.js";

const servers: ReturnType<typeof createGatewayHttpServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const silentLogger: Logger = { info: vi.fn(), error: vi.fn() };
const config: AppConfig = {
  mem0: { baseUrl: new URL("http://localhost:8888"), apiKey: "mem0-secret", timeoutMs: 1000 },
  scope: { tenant: "test", project: "test", subject: "test" },
  server: {
    host: "127.0.0.1",
    port: 8765,
    apiKey: "gateway-secret",
    allowedOrigins: new Set(["http://localhost:3080"]),
  },
};

function serviceMock(): MemoryService {
  return {
    add: vi.fn(), search: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn(),
  } as unknown as MemoryService;
}

async function start(readinessCheck: () => Promise<void> = async () => {}): Promise<URL> {
  const server = createGatewayHttpServer(serviceMock(), config, silentLogger, readinessCheck);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

describe("health endpoints", () => {
  it("reports liveness without authentication or an upstream check", async () => {
    const readinessCheck = vi.fn().mockRejectedValue(new Error("Mem0 unavailable"));
    const url = new URL("/health/live", await start(readinessCheck));
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(readinessCheck).not.toHaveBeenCalled();
  });

  it("reports readiness when Mem0 is reachable", async () => {
    const readinessCheck = vi.fn().mockResolvedValue(undefined);
    const url = new URL("/health/ready", await start(readinessCheck));
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(readinessCheck).toHaveBeenCalledOnce();
  });

  it("reports not ready without exposing the upstream error", async () => {
    const readinessCheck = vi.fn().mockRejectedValue(new Error("secret upstream detail"));
    const url = new URL("/health/ready", await start(readinessCheck));
    const response = await fetch(url);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready" });
  });
});

describe("Streamable HTTP security boundary", () => {
  it("serves MCP over authenticated stateless Streamable HTTP", async () => {
    const url = await start();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer gateway-secret" } },
    });
    const client = new Client({ name: "generic-http-client", version: "1.0.0" });
    await client.connect(transport as Transport);
    expect((await client.listTools()).tools).toHaveLength(5);
    await client.close();
  });

  it("rejects missing gateway authentication", async () => {
    const response = await fetch(await start(), { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("rejects an unlisted Origin without leaking endpoint details", async () => {
    const response = await fetch(await start(), {
      method: "POST",
      headers: { Origin: "https://evil.example", Authorization: "Bearer gateway-secret" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("permits configured origins", async () => {
    const response = await fetch(await start(), {
      method: "POST",
      headers: { Origin: "http://localhost:3080", Authorization: "Bearer gateway-secret" },
      body: "{}",
    });
    expect(response.status).not.toBe(403);
  });
});
