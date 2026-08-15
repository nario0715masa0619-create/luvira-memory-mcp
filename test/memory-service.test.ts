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
