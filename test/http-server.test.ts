import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAuthRegistry, TokenAuthRegistry } from "../src/auth-registry.js";
import type { AppConfig } from "../src/config.js";
import type { AuditSink } from "../src/governance/audit-sink.js";
import { createGatewayHttpServer } from "../src/http-server.js";
import type { Logger } from "../src/logger.js";
import { Mem0Client } from "../src/mem0-client.js";
import { scopeToMem0UserId } from "../src/scope.js";

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
  governance: { auditPath: "unused-in-this-test.jsonl" },
  authRegistry: { path: "unused-in-this-test.json", required: false },
};

const authRegistry = new TokenAuthRegistry([
  { token: "gateway-secret", tenant: "test", project: "test", subject: "test", role: "read_write" },
]);

function mem0Mock(): Mem0Client {
  return {
    add: vi.fn(), search: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn(), ready: vi.fn(),
  } as unknown as Mem0Client;
}

function auditSinkMock(): AuditSink {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

function mem0ClientWithFetch(fetchMock: typeof fetch): Mem0Client {
  return new Mem0Client({ baseUrl: new URL("http://localhost:8888"), apiKey: "mem0-secret", timeoutMs: 1000, fetch: fetchMock });
}

async function startServer(
  mem0: Mem0Client,
  registry: TokenAuthRegistry,
  auditSink: AuditSink = auditSinkMock(),
  readinessCheck: () => Promise<void> = async () => {},
): Promise<URL> {
  const server = createGatewayHttpServer(mem0, auditSink, config, silentLogger, registry, readinessCheck);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function start(readinessCheck: () => Promise<void> = async () => {}): Promise<URL> {
  return startServer(mem0Mock(), authRegistry, auditSinkMock(), readinessCheck);
}

async function callToolAt(
  url: URL,
  bearerToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const client = new Client({ name: "phase2-test-client", version: "1.0.0" });
  await client.connect(transport as Transport);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return result;
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

  it("rejects a Bearer token that is not in the auth registry", async () => {
    const response = await fetch(await start(), {
      method: "POST",
      headers: { Authorization: "Bearer not-a-registered-token" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});

describe("multi-token auth registry", () => {
  it("accepts any token present in the registry, not only the first", async () => {
    const url = await startServer(
      mem0Mock(),
      new TokenAuthRegistry([
        { token: "token-a", tenant: "test", project: "test", subject: "test", role: "read_write" },
        { token: "token-b", tenant: "test", project: "kimi-project", subject: "test", role: "read_only" },
      ]),
    );

    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer token-b" },
      body: "{}",
    });
    expect(response.status).not.toBe(401);
  });
});

describe("Project-Aware Scope (Phase 2): per-request scope isolation", () => {
  const scopeA = { tenant: "test", project: "project-a", subject: "user-1" };
  const scopeB = { tenant: "test", project: "project-b", subject: "user-1" };
  const twoProjectRegistry = new TokenAuthRegistry([
    { token: "token-a", ...scopeA, role: "read_write" },
    { token: "token-b", ...scopeB, role: "read_write" },
  ]);

  function okAddResponse(): Response {
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }

  it("resolves token A's memory_add to project-a's Mem0 user_id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okAddResponse());
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    await callToolAt(url, "token-a", "memory_add", { messages: [{ role: "user", content: "hi" }] });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).user_id).toBe(scopeToMem0UserId(scopeA));
  });

  it("resolves token B's memory_add to project-b's Mem0 user_id, on the same running Gateway process", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okAddResponse());
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    await callToolAt(url, "token-a", "memory_add", { messages: [{ role: "user", content: "from a" }] });
    await callToolAt(url, "token-b", "memory_add", { messages: [{ role: "user", content: "from b" }] });

    const userIds = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).user_id as string);
    expect(userIds).toEqual([scopeToMem0UserId(scopeA), scopeToMem0UserId(scopeB)]);
  });

  it("resolves the same token to the same user_id across separate requests (deterministic)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okAddResponse());
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    await callToolAt(url, "token-a", "memory_add", { messages: [{ role: "user", content: "one" }] });
    await callToolAt(url, "token-a", "memory_add", { messages: [{ role: "user", content: "two" }] });

    const userIds = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).user_id as string);
    expect(userIds).toEqual([scopeToMem0UserId(scopeA), scopeToMem0UserId(scopeA)]);
  });

  it("injects the resolved project's user_id into memory_search filters, not the other project's", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    await callToolAt(url, "token-b", "memory_search", { query: "q" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).filters).toEqual({ user_id: scopeToMem0UserId(scopeB) });
  });

  it("composes handoff_project_id and classification into the real Mem0 search request body, without widening user_id (ADR-003 Handoff Identity Safety)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    await callToolAt(url, "token-a", "memory_search", { query: "q", handoff_project_id: "luvira-os" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).filters).toEqual({
      user_id: scopeToMem0UserId(scopeA),
      handoff_project_id: "luvira-os",
      classification: "TEMPORARY_CONTEXT",
    });
  });

  it("keeps two handoff_project_id values isolated by exact-match filter within the same shared scope (deterministic retrieval, not semantic ranking)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const sharedScopeRegistry = new TokenAuthRegistry([
      { token: "token-shared", tenant: "test", project: "shared", subject: "owner", role: "read_write" },
    ]);
    const url = await startServer(mem0ClientWithFetch(fetchMock), sharedScopeRegistry);
    await callToolAt(url, "token-shared", "memory_search", { query: "current status", handoff_project_id: "project-alpha" });
    await callToolAt(url, "token-shared", "memory_search", { query: "current status", handoff_project_id: "project-beta" });

    const filtersSeen = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).filters);
    expect(filtersSeen[0]).toMatchObject({ handoff_project_id: "project-alpha" });
    expect(filtersSeen[1]).toMatchObject({ handoff_project_id: "project-beta" });
    expect(filtersSeen[0]).toEqual(filtersSeen[0]);
    expect(filtersSeen[0]).not.toEqual(filtersSeen[1]);
  });

  it("rejects memory_get for a memory owned by a different project's scope as not_found", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "mem-1", user_id: scopeToMem0UserId(scopeB), memory: "project-b content" }), { status: 200 }),
    );
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    const result = await callToolAt(url, "token-a", "memory_get", { memory_id: "mem-1" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("rejects memory_update for a memory owned by a different project's scope without mutating it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "mem-1", user_id: scopeToMem0UserId(scopeB) }), { status: 200 }),
    );
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    const result = await callToolAt(url, "token-a", "memory_update", { memory_id: "mem-1", text: "changed" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the ownership GET — no PUT reached Mem0
  });

  it("rejects memory_delete for a memory owned by a different project's scope without deleting it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "mem-1", user_id: scopeToMem0UserId(scopeB) }), { status: 200 }),
    );
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    const result = await callToolAt(url, "token-a", "memory_delete", { memory_id: "mem-1" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the ownership GET — no DELETE reached Mem0
  });

  it("does not let a spoofed source_project field change the resolved Mem0 user_id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okAddResponse());
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    await callToolAt(url, "token-a", "memory_add", {
      messages: [{ role: "user", content: "hi" }],
      source_project: "project-b",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).user_id).toBe(scopeToMem0UserId(scopeA));
  });

  it("does not let a spoofed source_client field change the resolved Mem0 user_id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okAddResponse());
    const url = await startServer(mem0ClientWithFetch(fetchMock), twoProjectRegistry);
    await callToolAt(url, "token-a", "memory_add", {
      messages: [{ role: "user", content: "hi" }],
      source_client: "kimi",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).user_id).toBe(scopeToMem0UserId(scopeA));
  });

  it("falls back to the legacy single-token scope when no registry file exists", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okAddResponse());
    const fallbackRegistry = new TokenAuthRegistry(loadAuthRegistry(config, () => { throw new Error("ENOENT"); }));
    const url = await startServer(mem0ClientWithFetch(fetchMock), fallbackRegistry);
    await callToolAt(url, "gateway-secret", "memory_add", { messages: [{ role: "user", content: "hi" }] });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).user_id).toBe(scopeToMem0UserId(config.scope));
  });
});

describe("Project-Aware Scope (Phase 3): role enforcement", () => {
  const roleRegistry = new TokenAuthRegistry([
    { token: "token-readonly", tenant: "test", project: "project-a", subject: "user-1", role: "read_only" },
    { token: "token-readwrite", tenant: "test", project: "project-b", subject: "user-1", role: "read_write" },
  ]);

  it("allows memory_search for the read_only token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const url = await startServer(mem0ClientWithFetch(fetchMock), roleRegistry);
    const result = await callToolAt(url, "token-readonly", "memory_search", { query: "q" });

    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows memory_get for the read_only token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "mem-1", user_id: scopeToMem0UserId({ tenant: "test", project: "project-a", subject: "user-1" }) }), { status: 200 }),
    );
    const url = await startServer(mem0ClientWithFetch(fetchMock), roleRegistry);
    const result = await callToolAt(url, "token-readonly", "memory_get", { memory_id: "mem-1" });

    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["memory_add", "memory_update", "memory_delete"])("blocks %s for the read_only token before reaching Mem0", async (toolName) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const url = await startServer(mem0ClientWithFetch(fetchMock), roleRegistry);
    const args = toolName === "memory_add"
      ? { messages: [{ role: "user", content: "hi" }] }
      : toolName === "memory_update"
        ? { memory_id: "mem-1", text: "x" }
        : { memory_id: "mem-1" };
    const result = await callToolAt(url, "token-readonly", toolName, args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "role_forbidden_write" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets the read_write token reach the write handler and call Mem0", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const url = await startServer(mem0ClientWithFetch(fetchMock), roleRegistry);
    const result = await callToolAt(url, "token-readwrite", "memory_add", { messages: [{ role: "user", content: "hi" }] });

    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).user_id).toBe(
      scopeToMem0UserId({ tenant: "test", project: "project-b", subject: "user-1" }),
    );
  });
});
