import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/errors.js";
import type { Mem0Client } from "../src/mem0-client.js";
import { MemoryService } from "../src/memory-service.js";
import { StaticScopeResolver, scopeToMem0UserId } from "../src/scope.js";

const scope = { tenant: "personal", project: "shared", subject: "owner" };
const userId = scopeToMem0UserId(scope);

function mockClient(): Mem0Client {
  return {
    add: vi.fn().mockResolvedValue({ results: [] }),
    search: vi.fn().mockResolvedValue({ results: [] }),
    get: vi.fn().mockResolvedValue({ id: "owned", user_id: userId, memory: "private" }),
    update: vi.fn().mockResolvedValue({ id: "owned", user_id: userId }),
    delete: vi.fn().mockResolvedValue({ message: "Memory deleted successfully" }),
  } as unknown as Mem0Client;
}

describe("MemoryService scope boundary", () => {
  it("injects user_id on add and never accepts it from callers", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await service.add({ messages: [{ role: "user", content: "content" }] });
    expect(client.add).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "content" }],
      user_id: userId,
    });
  });

  it("force-injects exactly one user_id search filter", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await service.search({ query: "query", top_k: 5 });
    expect(client.search).toHaveBeenCalledWith({ query: "query", top_k: 5, filters: { user_id: userId } });
  });

  it.each(["get", "update", "delete"])("hides out-of-scope memory during %s", async (operation) => {
    const client = mockClient();
    vi.mocked(client.get).mockResolvedValue({ id: "foreign", user_id: "another-scope", memory: "do not leak" });
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    const call = operation === "get"
      ? service.get("foreign")
      : operation === "update"
        ? service.update("foreign", { text: "x" })
        : service.delete("foreign");
    await expect(call).rejects.toMatchObject({ code: "not_found", message: "Memory not found" } satisfies Partial<GatewayError>);
    expect(client.update).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("rejects reserved metadata keys", async () => {
    const service = new MemoryService(mockClient(), new StaticScopeResolver(scope));
    await expect(
      service.add({ messages: [{ role: "user", content: "x" }], metadata: { user_id: "escape" } }),
    ).rejects.toMatchObject({ code: "validation_error" } satisfies Partial<GatewayError>);
  });
});

describe("MemoryService high-confidence secret governance (Phase 3, AR-4)", () => {
  const FAKE_GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

  it("adds an ordinary memory unchanged", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await service.add({ messages: [{ role: "user", content: "remember the deploy window is Friday" }] });
    expect(client.add).toHaveBeenCalledTimes(1);
  });

  it("blocks add when message content matches a high-confidence secret and never calls upstream", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await expect(
      service.add({ messages: [{ role: "user", content: FAKE_GITHUB_TOKEN }] }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });

  it("blocks add when metadata contains a high-confidence secret and never calls upstream", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await expect(
      service.add({
        messages: [{ role: "user", content: "safe text" }],
        metadata: { nested: { token: FAKE_GITHUB_TOKEN } },
      }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });

  it("updates an ordinary memory unchanged", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await service.update("owned", { text: "deploy window moved to Monday" });
    expect(client.update).toHaveBeenCalledTimes(1);
  });

  it("blocks update when the new text matches a high-confidence secret and never calls upstream get or update", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await expect(
      service.update("owned", { text: FAKE_GITHUB_TOKEN }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("blocks update when metadata matches a high-confidence secret and never calls upstream get or update", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await expect(
      service.update("owned", { metadata: { key: FAKE_GITHUB_TOKEN } }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("leaves search unaffected by secret governance", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await service.search({ query: FAKE_GITHUB_TOKEN });
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it("leaves get unaffected by secret governance", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await service.get("owned");
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("leaves delete unaffected by secret governance", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    await service.delete("owned");
    expect(client.delete).toHaveBeenCalledTimes(1);
  });

  it("never includes the matched secret value in the thrown error", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope));
    try {
      await service.add({ messages: [{ role: "user", content: FAKE_GITHUB_TOKEN }] });
      throw new Error("expected service.add to reject");
    } catch (error) {
      const serialized = JSON.stringify({ message: (error as GatewayError).message, name: (error as GatewayError).name });
      expect(serialized).not.toContain(FAKE_GITHUB_TOKEN);
      expect(serialized).not.toContain("ghp_");
    }
  });
});
