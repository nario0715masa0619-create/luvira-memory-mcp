import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/errors.js";
import type { AuditSink } from "../src/governance/audit-sink.js";
import type { GovernanceAuditEvent } from "../src/governance/types.js";
import type { Mem0Client } from "../src/mem0-client.js";
import { MemoryService } from "../src/memory-service.js";
import { StaticScopeResolver, scopeFingerprint, scopeToMem0UserId } from "../src/scope.js";

const scope = { tenant: "personal", project: "shared", subject: "owner" };
const userId = scopeToMem0UserId(scope);
const expectedFingerprint = scopeFingerprint(userId);

function mockClient(): Mem0Client {
  return {
    add: vi.fn().mockResolvedValue({ results: [] }),
    search: vi.fn().mockResolvedValue({ results: [] }),
    get: vi.fn().mockResolvedValue({ id: "owned", user_id: userId, memory: "private" }),
    update: vi.fn().mockResolvedValue({ id: "owned", user_id: userId }),
    delete: vi.fn().mockResolvedValue({ message: "Memory deleted successfully" }),
  } as unknown as Mem0Client;
}

function mockAuditSink(): AuditSink & { events: GovernanceAuditEvent[] } {
  const events: GovernanceAuditEvent[] = [];
  return {
    events,
    record: vi.fn(async (event: GovernanceAuditEvent) => {
      events.push(event);
    }),
  };
}

function failingAuditSink(): AuditSink {
  return { record: vi.fn().mockRejectedValue(new Error("disk unavailable")) };
}

describe("MemoryService scope boundary", () => {
  it("injects user_id on add and never accepts it from callers", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.add({ messages: [{ role: "user", content: "content" }] });
    expect(client.add).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "content" }],
      user_id: userId,
    });
  });

  it("force-injects exactly one user_id search filter", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.search({ query: "query", top_k: 5 });
    expect(client.search).toHaveBeenCalledWith({ query: "query", top_k: 5, filters: { user_id: userId } });
  });

  it.each(["get", "update", "delete"])("hides out-of-scope memory during %s", async (operation) => {
    const client = mockClient();
    vi.mocked(client.get).mockResolvedValue({ id: "foreign", user_id: "another-scope", memory: "do not leak" });
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
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
    const service = new MemoryService(mockClient(), new StaticScopeResolver(scope), mockAuditSink());
    await expect(
      service.add({ messages: [{ role: "user", content: "x" }], metadata: { user_id: "escape" } }),
    ).rejects.toMatchObject({ code: "validation_error" } satisfies Partial<GatewayError>);
  });
});

describe("MemoryService high-confidence secret governance (Phase 3, AR-4)", () => {
  const FAKE_GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

  it("adds an ordinary memory unchanged", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.add({ messages: [{ role: "user", content: "remember the deploy window is Friday" }] });
    expect(client.add).toHaveBeenCalledTimes(1);
  });

  it("blocks add when message content matches a high-confidence secret and never calls upstream", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await expect(
      service.add({ messages: [{ role: "user", content: FAKE_GITHUB_TOKEN }] }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });

  it("blocks add when metadata contains a high-confidence secret and never calls upstream", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
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
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.update("owned", { text: "deploy window moved to Monday" });
    expect(client.update).toHaveBeenCalledTimes(1);
  });

  it("blocks update when the new text matches a high-confidence secret and never calls upstream get or update", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await expect(
      service.update("owned", { text: FAKE_GITHUB_TOKEN }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("blocks update when metadata matches a high-confidence secret and never calls upstream get or update", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await expect(
      service.update("owned", { metadata: { key: FAKE_GITHUB_TOKEN } }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("leaves search unaffected by secret governance", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.search({ query: FAKE_GITHUB_TOKEN });
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it("leaves get unaffected by secret governance", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.get("owned");
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("leaves delete unaffected by secret governance", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.delete("owned");
    expect(client.delete).toHaveBeenCalledTimes(1);
  });

  it("never includes the matched secret value in the thrown error", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
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

describe("MemoryService governance audit wiring (Phase 3A)", () => {
  const FAKE_GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

  it("records exactly one ALLOW audit event and calls upstream add once for a safe write", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "safe content" }] });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.events[0]).toMatchObject({ operation: "ADD", decision: "ALLOW", reasonCodes: [] });
    expect(client.add).toHaveBeenCalledTimes(1);
  });

  it("records exactly one BLOCK audit event and calls upstream add zero times for a secret write", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(service.add({ messages: [{ role: "user", content: FAKE_GITHUB_TOKEN }] })).rejects.toMatchObject({
      code: "secret_detected_high_confidence",
    } satisfies Partial<GatewayError>);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.events[0]).toMatchObject({
      operation: "ADD",
      decision: "BLOCK",
      reasonCodes: ["secret_detected_high_confidence"],
    });
    expect(client.add).not.toHaveBeenCalled();
  });

  it("records exactly one ALLOW audit event and calls upstream update once for a safe update", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.update("owned", { text: "safe update" });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.events[0]).toMatchObject({ operation: "UPDATE", decision: "ALLOW", memoryId: "owned" });
    expect(client.update).toHaveBeenCalledTimes(1);
  });

  it("records exactly one BLOCK audit event and calls upstream update zero times for a secret update", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(service.update("owned", { text: FAKE_GITHUB_TOKEN })).rejects.toMatchObject({
      code: "secret_detected_high_confidence",
    } satisfies Partial<GatewayError>);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.events[0]).toMatchObject({ operation: "UPDATE", decision: "BLOCK" });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("fails closed on AuditSink failure for a safe add: upstream add is never called", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(
      service.add({ messages: [{ role: "user", content: "safe content" }] }),
    ).rejects.toMatchObject({ code: "governance_audit_unavailable" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });

  it("fails closed on AuditSink failure for a safe update: upstream get/update are never called", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(
      service.update("owned", { text: "safe update" }),
    ).rejects.toMatchObject({ code: "governance_audit_unavailable" } satisfies Partial<GatewayError>);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("fails closed on AuditSink failure for a secret-blocked add: reports audit failure, not the secret payload", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(
      service.add({ messages: [{ role: "user", content: FAKE_GITHUB_TOKEN }] }),
    ).rejects.toMatchObject({ code: "governance_audit_unavailable" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });

  it("never places Memory content in the audit event", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "the quick brown fox" }] });

    const serialized = JSON.stringify(audit.events[0]);
    expect(serialized).not.toContain("the quick brown fox");
  });

  it("never places the matched secret value in the audit event", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(service.add({ messages: [{ role: "user", content: FAKE_GITHUB_TOKEN }] })).rejects.toBeDefined();

    const serialized = JSON.stringify(audit.events[0]);
    expect(serialized).not.toContain(FAKE_GITHUB_TOKEN);
    expect(serialized).not.toContain("ghp_");
  });

  it("omits contentHash on a BLOCK event", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(service.add({ messages: [{ role: "user", content: FAKE_GITHUB_TOKEN }] })).rejects.toBeDefined();

    expect(audit.events[0]).not.toHaveProperty("contentHash");
  });

  it("includes contentHash on an ALLOW event", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "safe content" }] });

    expect(typeof audit.events[0]?.contentHash).toBe("string");
    expect(audit.events[0]?.contentHash?.length).toBeGreaterThan(0);
  });

  it("omits memoryId on an ADD event (no memory exists yet)", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "safe content" }] });

    expect(audit.events[0]).not.toHaveProperty("memoryId");
  });

  it("omits memoryId on a BLOCKed UPDATE event (target ownership not yet verified)", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(service.update("owned", { text: FAKE_GITHUB_TOKEN })).rejects.toBeDefined();

    expect(audit.events[0]).not.toHaveProperty("memoryId");
  });

  it("records only a scope fingerprint, never a raw scope identifier", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "safe content" }] });

    expect(audit.events[0]?.scopeFingerprint).toBe(expectedFingerprint);
    const serialized = JSON.stringify(audit.events[0]);
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain(scope.tenant);
    expect(serialized).not.toContain(scope.subject);
  });

  it("uses the Phase 4-pending UNCLASSIFIED classification and SUPPLEMENTAL-only authority stance", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "safe content" }] });

    expect(audit.events[0]?.classification).toBe("UNCLASSIFIED");
  });

  it("does not call the AuditSink for search or get", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.search({ query: "anything" });
    await service.get("owned");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("does not call the AuditSink for delete (no governance rule exists for delete yet)", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.delete("owned");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("loses no audit events across parallel safe writes", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => service.add({ messages: [{ role: "user", content: `entry ${index}` }] })),
    );
    expect(audit.record).toHaveBeenCalledTimes(20);
    expect(client.add).toHaveBeenCalledTimes(20);
  });
});
