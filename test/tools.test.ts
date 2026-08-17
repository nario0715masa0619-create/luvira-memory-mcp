import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/errors.js";
import type { MemoryService } from "../src/memory-service.js";
import { AUTHORITY_NOTICE, createMcpServer } from "../src/tools.js";

function serviceMock(): MemoryService {
  return {
    add: vi.fn().mockResolvedValue({ results: [] }),
    search: vi.fn().mockResolvedValue({ results: [{ id: "1" }] }),
    get: vi.fn().mockResolvedValue({ id: "1" }),
    update: vi.fn().mockResolvedValue({ id: "1" }),
    delete: vi.fn().mockResolvedValue({ message: "Memory deleted successfully" }),
  } as unknown as MemoryService;
}

const closeCallbacks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connected(service = serviceMock()): Promise<{ client: Client; service: MemoryService }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(service);
  const client = new Client({ name: "generic-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(() => client.close(), () => server.close());
  return { client, service };
}

describe("MCP tools", () => {
  it("exposes exactly five client-agnostic tools without user_id inputs", async () => {
    const { client } = await connected();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "memory_add", "memory_search", "memory_get", "memory_update", "memory_delete",
    ]);
    for (const tool of listed.tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("user_id");
      expect(tool.name).not.toMatch(/librechat|codex|claude|cursor/i);
      expect(tool.description).toContain(AUTHORITY_NOTICE);
    }
    expect(listed.tools.find((tool) => tool.name === "memory_update")?.inputSchema).toMatchObject({
      required: ["memory_id"],
      properties: { memory_id: { type: "string" }, text: {}, metadata: {}, expiration_date: {} },
    });
    expect(listed.tools.find((tool) => tool.name === "memory_search")?.description).toContain(AUTHORITY_NOTICE);
  });

  it("returns structured supplemental content", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({ name: "memory_search", arguments: { query: "preference" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: true, source: "mem0", authority: "supplemental" });
    expect(service.search).toHaveBeenCalledWith({ query: "preference", show_expired: false });
  });

  it("normalizes service failures as Tool Execution Errors", async () => {
    const service = serviceMock();
    vi.mocked(service.get).mockRejectedValue(new GatewayError("not_found", "Memory not found"));
    const { client } = await connected(service);
    const result = await client.callTool({ name: "memory_get", arguments: { memory_id: "foreign" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: "not_found", message: "Memory not found", retryable: false },
      source: "mem0",
      authority: "supplemental",
    });
  });

  it("rejects invalid tool input before service execution", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({ name: "memory_search", arguments: { query: "" } });
    expect(result.isError).toBe(true);
    expect(service.search).not.toHaveBeenCalled();
  });

  it("requires at least one memory_update field", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({ name: "memory_update", arguments: { memory_id: "1" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
    expect(service.update).not.toHaveBeenCalled();
  });
});

describe("Classification / Provenance input (Phase 4)", () => {
  it("accepts existing memory_add input with no governance fields, unchanged", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(result.isError).not.toBe(true);
    expect(service.add).toHaveBeenCalledWith({ messages: [{ role: "user", content: "hello" }] });
  });

  it("accepts existing memory_update input with no governance fields, unchanged", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_update",
      arguments: { memory_id: "1", text: "updated" },
    });
    expect(result.isError).not.toBe(true);
    expect(service.update).toHaveBeenCalledWith("1", { text: "updated" });
  });

  it("accepts a valid classification on memory_add", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }], classification: "PROJECT_FACT" },
    });
    expect(result.isError).not.toBe(true);
    expect(service.add).toHaveBeenCalledWith(
      expect.objectContaining({ classification: "PROJECT_FACT" }),
    );
  });

  it("rejects an invalid classification on memory_add before service execution", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }], classification: "NOT_A_REAL_VALUE" },
    });
    expect(result.isError).toBe(true);
    expect(service.add).not.toHaveBeenCalled();
  });

  it.each(["UNCLASSIFIED", "LEGACY_UNKNOWN"])(
    "rejects the internal-only classification value %s from external callers",
    async (value) => {
      const { client, service } = await connected();
      const result = await client.callTool({
        name: "memory_add",
        arguments: { messages: [{ role: "user", content: "hello" }], classification: value },
      });
      expect(result.isError).toBe(true);
      expect(service.add).not.toHaveBeenCalled();
    },
  );

  it("accepts a valid source_type on memory_add", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }], source_type: "USER_EXPLICIT" },
    });
    expect(result.isError).not.toBe(true);
    expect(service.add).toHaveBeenCalledWith(expect.objectContaining({ source_type: "USER_EXPLICIT" }));
  });

  it("rejects an invalid source_type on memory_add before service execution", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }], source_type: "NOT_A_REAL_VALUE" },
    });
    expect(result.isError).toBe(true);
    expect(service.add).not.toHaveBeenCalled();
  });

  it("rejects the internal-only source_type value LEGACY_UNKNOWN from external callers", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }], source_type: "LEGACY_UNKNOWN" },
    });
    expect(result.isError).toBe(true);
    expect(service.add).not.toHaveBeenCalled();
  });

  it("accepts explicit_user_request as a boolean on memory_add", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }], explicit_user_request: true },
    });
    expect(result.isError).not.toBe(true);
    expect(service.add).toHaveBeenCalledWith(expect.objectContaining({ explicit_user_request: true }));
  });

  it("accepts an optional source_project on memory_add", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }], source_project: "luvira-memory-mcp" },
    });
    expect(result.isError).not.toBe(true);
    expect(service.add).toHaveBeenCalledWith(expect.objectContaining({ source_project: "luvira-memory-mcp" }));
  });

  it("accepts an optional source_client on memory_add", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_add",
      arguments: { messages: [{ role: "user", content: "hello" }], source_client: "claude-code" },
    });
    expect(result.isError).not.toBe(true);
    expect(service.add).toHaveBeenCalledWith(expect.objectContaining({ source_client: "claude-code" }));
  });

  it("accepts classification and provenance fields on memory_update", async () => {
    const { client, service } = await connected();
    const result = await client.callTool({
      name: "memory_update",
      arguments: {
        memory_id: "1",
        text: "updated",
        classification: "WORKFLOW_STATE",
        source_client: "codex",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(service.update).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ text: "updated", classification: "WORKFLOW_STATE", source_client: "codex" }),
    );
  });

  it("does not require a client-specific tool name or enum for source_client", async () => {
    const { client } = await connected();
    const listed = await client.listTools();
    const addSchema = JSON.stringify(listed.tools.find((tool) => tool.name === "memory_add")?.inputSchema);
    expect(addSchema).not.toMatch(/"enum":\s*\[\s*"(claude-code|codex|librechat|kimi-code)"/i);
  });
});
