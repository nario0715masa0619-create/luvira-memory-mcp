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

  it("fails closed on AuditSink failure for a safe update: upstream get is read (Automation Policy needs existing classification) but update is never called", async () => {
    // Memory Governance MVP (Section 9): UPDATE's Automation Policy decision
    // must consider the target Memory's *existing* classification, which
    // requires the ownership read (getOwned) to happen before the single
    // audit record for this call. This is a deliberate, minimal change from
    // the Phase 3A shape of this test — the mutation-zero and fail-closed
    // guarantees below are unchanged; only "no Mem0 call happens at all"
    // narrows to "no Mem0 *write* happens".
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(
      service.update("owned", { text: "safe update" }),
    ).rejects.toMatchObject({ code: "governance_audit_unavailable" } satisfies Partial<GatewayError>);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.update).not.toHaveBeenCalled();
  });

  it("fails closed on AuditSink failure for an early-blocked update (secret content): upstream get/update are never called", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(
      service.update("owned", { text: FAKE_GITHUB_TOKEN }),
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

  it("calls the AuditSink for delete (Memory Governance MVP, Section 10.2)", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.delete("owned");
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.events[0]).toMatchObject({ operation: "DELETE", decision: "ALLOW", memoryId: "owned" });
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

describe("MemoryService classification / provenance governance (Phase 4)", () => {
  it("audits UNCLASSIFIED and keeps existing write behavior when no governance fields are given", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "plain note" }] });

    expect(audit.events[0]?.classification).toBe("UNCLASSIFIED");
    expect(client.add).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "plain note" }],
      user_id: userId,
    });
  });

  it("records the caller-declared classification in the audit event", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "note" }], classification: "PROJECT_FACT" });

    expect(audit.events[0]?.classification).toBe("PROJECT_FACT");
  });

  it("records the caller-declared source_type in the audit event", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "note" }], source_type: "USER_EXPLICIT" });

    expect(audit.events[0]?.sourceType).toBe("USER_EXPLICIT");
  });

  it("maps explicit_user_request=true to WriteIntent EXPLICIT_REPORTED", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "note" }], explicit_user_request: true });

    expect(audit.events[0]?.writeIntent).toBe("EXPLICIT_REPORTED");
  });

  it("maps explicit_user_request=false to WriteIntent IMPLICIT", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "note" }], explicit_user_request: false });

    expect(audit.events[0]?.writeIntent).toBe("IMPLICIT");
  });

  it("omits writeIntent entirely when explicit_user_request is not supplied", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({ messages: [{ role: "user", content: "note" }] });

    expect(audit.events[0]).not.toHaveProperty("writeIntent");
  });

  it("preserves source_project and source_client as provenance in the audit event", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.add({
      messages: [{ role: "user", content: "note" }],
      source_project: "luvira-memory-mcp",
      source_client: "claude-code",
    });

    expect(audit.events[0]?.sourceProject).toBe("luvira-memory-mcp");
    expect(audit.events[0]?.sourceClient).toBe("claude-code");
  });

  it("injects canonical classification and authority into the Mem0-bound metadata", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.add({
      messages: [{ role: "user", content: "note" }],
      classification: "LONG_TERM_KNOWLEDGE",
      metadata: { note: "caller value" },
    });

    expect(client.add).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { note: "caller value", classification: "LONG_TERM_KNOWLEDGE", authority: "supplemental" },
    }));
  });

  it("lets the Gateway-computed authority/classification win over a caller metadata key of the same name", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.add({
      messages: [{ role: "user", content: "note" }],
      classification: "PROJECT_FACT",
      metadata: { authority: "approved", classification: "SOMETHING_ELSE" },
    });

    expect(client.add).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { authority: "supplemental", classification: "PROJECT_FACT" },
    }));
  });

  it("still runs pattern-based secret detection regardless of a benign declared classification", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(
      service.add({
        messages: [{ role: "user", content: "ghp_1234567890abcdefghijklmnopqrstuvwxyz" }],
        classification: "USER_PREFERENCE",
      }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
    expect(audit.events[0]).toMatchObject({ decision: "BLOCK", reasonCodes: ["secret_detected_high_confidence"] });
  });

  it.each(["SECRET", "CUSTOMER_CONFIDENTIAL"] as const)(
    "blocks a self-declared %s classification even with otherwise-safe content, and calls upstream add zero times",
    async (classification) => {
      const client = mockClient();
      const audit = mockAuditSink();
      const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
      await expect(
        service.add({ messages: [{ role: "user", content: "ordinary safe text" }], classification }),
      ).rejects.toMatchObject({ code: "classification_restricted" } satisfies Partial<GatewayError>);

      expect(client.add).not.toHaveBeenCalled();
      expect(audit.events[0]).toMatchObject({
        decision: "BLOCK",
        classification,
        reasonCodes: ["classification_restricted"],
      });
      expect(audit.events[0]).not.toHaveProperty("contentHash");
    },
  );

  it("blocks a self-declared SECRET classification on update and calls upstream get/update zero times", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(
      service.update("owned", { text: "ordinary safe text", classification: "SECRET" }),
    ).rejects.toMatchObject({ code: "classification_restricted" } satisfies Partial<GatewayError>);

    expect(client.get).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("does not reject a caller metadata key that shares a name with a governance field (Decision B)", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await expect(
      service.add({
        messages: [{ role: "user", content: "note" }],
        metadata: { source_type: "integration_test", authority: "supplemental", test_run: "abc" },
      }),
    ).resolves.toBeDefined();
    expect(client.add).toHaveBeenCalledTimes(1);
  });

  it("still fails closed on AuditSink failure even when governance fields are present", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(
      service.add({
        messages: [{ role: "user", content: "note" }],
        classification: "WORKFLOW_STATE",
        source_client: "codex",
      }),
    ).rejects.toMatchObject({ code: "governance_audit_unavailable" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });

  it("does not persist governance metadata into Mem0 metadata for update when the caller did not touch metadata", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.update("owned", { text: "new text", classification: "PROJECT_FACT" });

    expect(client.update).toHaveBeenCalledWith("owned", { text: "new text" });
  });

  it("injects governance metadata into Mem0 metadata for update when the caller already sends metadata", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.update("owned", { metadata: { note: "x" }, classification: "PROJECT_FACT" });

    expect(client.update).toHaveBeenCalledWith("owned", {
      metadata: { note: "x", classification: "PROJECT_FACT", authority: "supplemental" },
    });
  });
});

describe("MemoryService infer=true governance (Memory Governance MVP, Section 8)", () => {
  it("blocks add when infer=true and never calls upstream add", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(
      service.add({ messages: [{ role: "user", content: "safe content" }], infer: true }),
    ).rejects.toMatchObject({ code: "opaque_upstream_mutation_not_allowed" } satisfies Partial<GatewayError>);

    expect(client.add).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.events[0]).toMatchObject({
      operation: "ADD",
      decision: "BLOCK",
      reasonCodes: ["opaque_upstream_mutation_not_allowed"],
    });
    expect(audit.events[0]).not.toHaveProperty("contentHash");
  });

  it("preserves existing behavior when infer is false", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.add({ messages: [{ role: "user", content: "safe content" }], infer: false });
    expect(client.add).toHaveBeenCalledWith(expect.objectContaining({ infer: false }));
  });

  it("preserves existing behavior when infer is omitted", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.add({ messages: [{ role: "user", content: "safe content" }] });
    expect(client.add).toHaveBeenCalledTimes(1);
    const [call] = vi.mocked(client.add).mock.calls[0]!;
    expect(call).not.toHaveProperty("infer");
  });

  it("fails closed on AuditSink failure for an infer=true block: upstream add is never called", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(
      service.add({ messages: [{ role: "user", content: "safe content" }], infer: true }),
    ).rejects.toMatchObject({ code: "governance_audit_unavailable" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });

  it("blocks infer=true even when combined with an otherwise-privileged EXPLICIT_REPORTED write", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await expect(
      service.add({
        messages: [{ role: "user", content: "safe content" }],
        infer: true,
        classification: "USER_DECISION",
        explicit_user_request: true,
      }),
    ).rejects.toMatchObject({ code: "opaque_upstream_mutation_not_allowed" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });
});

describe("MemoryService Automation Policy integration on add (Memory Governance MVP, Section 5-6)", () => {
  it.each(["USER_DECISION", "ORGANIZATION_POLICY", "PROJECT_DECISION"] as const)(
    "%s: ALLOW with explicit_user_request=true, BLOCK automation_policy_restricted without it",
    async (classification) => {
      const client = mockClient();
      const audit = mockAuditSink();
      const service = new MemoryService(client, new StaticScopeResolver(scope), audit);

      await service.add({ messages: [{ role: "user", content: "note" }], classification, explicit_user_request: true });
      expect(client.add).toHaveBeenCalledTimes(1);
      expect(audit.events[0]).toMatchObject({ decision: "ALLOW" });

      await expect(
        service.add({ messages: [{ role: "user", content: "note 2" }], classification }),
      ).rejects.toMatchObject({ code: "automation_policy_restricted" } satisfies Partial<GatewayError>);
      expect(client.add).toHaveBeenCalledTimes(1);
      expect(audit.events[1]).toMatchObject({ decision: "BLOCK", reasonCodes: ["automation_policy_restricted"] });

      await expect(
        service.add({ messages: [{ role: "user", content: "note 3" }], classification, explicit_user_request: false }),
      ).rejects.toMatchObject({ code: "automation_policy_restricted" } satisfies Partial<GatewayError>);
      expect(client.add).toHaveBeenCalledTimes(1);
    },
  );

  it("EXTERNAL_UNTRUSTED: BLOCK with untrusted_source reason when not explicit_user_request", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(
      service.add({ messages: [{ role: "user", content: "note" }], classification: "EXTERNAL_UNTRUSTED" }),
    ).rejects.toMatchObject({ code: "automation_policy_restricted" } satisfies Partial<GatewayError>);
    expect(audit.events[0]).toMatchObject({ decision: "BLOCK", reasonCodes: ["untrusted_source"] });
    expect(client.add).not.toHaveBeenCalled();
  });

  it("EXTERNAL_UNTRUSTED: ALLOW with explicit_user_request=true", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.add({
      messages: [{ role: "user", content: "note" }],
      classification: "EXTERNAL_UNTRUSTED",
      explicit_user_request: true,
    });
    expect(client.add).toHaveBeenCalledTimes(1);
  });

  it.each(["USER_PREFERENCE", "PROJECT_FACT", "WORKFLOW_STATE", "LONG_TERM_KNOWLEDGE", "TEMPORARY_CONTEXT"] as const)(
    "%s: stays ALLOW regardless of writeIntent (legacy compatibility)",
    async (classification) => {
      const client = mockClient();
      const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
      await service.add({ messages: [{ role: "user", content: "note" }], classification });
      await service.add({ messages: [{ role: "user", content: "note 2" }], classification, explicit_user_request: false });
      await service.add({ messages: [{ role: "user", content: "note 3" }], classification, explicit_user_request: true });
      expect(client.add).toHaveBeenCalledTimes(3);
    },
  );

  it("UNCLASSIFIED (omitted classification) stays ALLOW with no explicit_user_request — full legacy calling style", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.add({ messages: [{ role: "user", content: "plain legacy note" }] });
    expect(client.add).toHaveBeenCalledTimes(1);
  });

  it("HIGH_CONFIDENCE secret detection overrides Automation Policy ALLOW (an always-ALLOW classification with explicit_user_request=true)", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(
      service.add({
        messages: [{ role: "user", content: "ghp_1234567890abcdefghijklmnopqrstuvwxyz" }],
        classification: "USER_PREFERENCE",
        explicit_user_request: true,
      }),
    ).rejects.toMatchObject({ code: "secret_detected_high_confidence" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
    expect(audit.events[0]).toMatchObject({ decision: "BLOCK", reasonCodes: ["secret_detected_high_confidence"] });
  });

  it("fails closed on AuditSink failure for an automation-policy BLOCK", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(
      service.add({ messages: [{ role: "user", content: "note" }], classification: "USER_DECISION" }),
    ).rejects.toMatchObject({ code: "governance_audit_unavailable" } satisfies Partial<GatewayError>);
    expect(client.add).not.toHaveBeenCalled();
  });
});

describe("MemoryService UPDATE Automation Policy + existing-classification protection (Memory Governance MVP, Section 9)", () => {
  it("blocks an implicit update declaring USER_DECISION and never calls upstream update", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(
      service.update("owned", { text: "revised decision", classification: "USER_DECISION" }),
    ).rejects.toMatchObject({ code: "automation_policy_restricted" } satisfies Partial<GatewayError>);
    expect(client.update).not.toHaveBeenCalled();
    expect(audit.events[0]).toMatchObject({ operation: "UPDATE", decision: "BLOCK", reasonCodes: ["automation_policy_restricted"] });
  });

  it("allows an explicit-reported update declaring USER_DECISION", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.update("owned", { text: "revised decision", classification: "USER_DECISION", explicit_user_request: true });
    expect(client.update).toHaveBeenCalledTimes(1);
  });

  it("a caller cannot bypass an existing PROJECT_DECISION record's protection by declaring a weaker classification (downgrade-bypass)", async () => {
    const client = mockClient();
    vi.mocked(client.get).mockResolvedValue({
      id: "owned",
      user_id: userId,
      metadata: { classification: "PROJECT_DECISION" },
    });
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);

    // Caller declares no classification at all (defaults to UNCLASSIFIED,
    // an always-ALLOW class) and does not report explicit_user_request —
    // the existing PROJECT_DECISION classification must still govern.
    await expect(
      service.update("owned", { text: "quietly rewritten" }),
    ).rejects.toMatchObject({ code: "automation_policy_restricted" } satisfies Partial<GatewayError>);
    expect(client.update).not.toHaveBeenCalled();
    expect(audit.events[0]).toMatchObject({ decision: "BLOCK", reasonCodes: ["automation_policy_restricted"] });
  });

  it("the downgrade-bypass protection is lifted by explicit_user_request=true", async () => {
    const client = mockClient();
    vi.mocked(client.get).mockResolvedValue({
      id: "owned",
      user_id: userId,
      metadata: { classification: "PROJECT_DECISION" },
    });
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.update("owned", { text: "deliberately rewritten", explicit_user_request: true });
    expect(client.update).toHaveBeenCalledTimes(1);
  });

  it("an existing record with no recoverable classification (legacy/pre-Governance record) is not falsely protected", async () => {
    const client = mockClient();
    vi.mocked(client.get).mockResolvedValue({ id: "owned", user_id: userId, memory: "legacy content" });
    const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
    await service.update("owned", { text: "ordinary update" });
    expect(client.update).toHaveBeenCalledTimes(1);
  });
});

describe("MemoryService DELETE governance (Memory Governance MVP, Section 10)", () => {
  it("allows deleting a memory with no recoverable classification, unaffected (legacy compatibility)", async () => {
    const client = mockClient();
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.delete("owned");
    expect(client.delete).toHaveBeenCalledTimes(1);
    expect(audit.events[0]).toMatchObject({ operation: "DELETE", decision: "ALLOW" });
  });

  it.each(["USER_DECISION", "ORGANIZATION_POLICY", "PROJECT_DECISION"] as const)(
    "blocks deleting a %s memory without explicit_user_request and never calls upstream delete",
    async (classification) => {
      const client = mockClient();
      vi.mocked(client.get).mockResolvedValue({ id: "owned", user_id: userId, metadata: { classification } });
      const audit = mockAuditSink();
      const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
      await expect(service.delete("owned")).rejects.toMatchObject({
        code: "automation_policy_restricted",
      } satisfies Partial<GatewayError>);
      expect(client.delete).not.toHaveBeenCalled();
      expect(audit.events[0]).toMatchObject({ operation: "DELETE", decision: "BLOCK", reasonCodes: ["automation_policy_restricted"] });
    },
  );

  it.each(["USER_DECISION", "ORGANIZATION_POLICY", "PROJECT_DECISION"] as const)(
    "allows deleting a %s memory when explicit_user_request=true",
    async (classification) => {
      const client = mockClient();
      vi.mocked(client.get).mockResolvedValue({ id: "owned", user_id: userId, metadata: { classification } });
      const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
      await service.delete("owned", { explicitUserRequest: true });
      expect(client.delete).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["SECRET", "CUSTOMER_CONFIDENTIAL"] as const)(
    "does NOT block deleting a legacy %s-classified memory (Section 10.1: deletion of restricted-classification legacy data must stay possible)",
    async (classification) => {
      const client = mockClient();
      vi.mocked(client.get).mockResolvedValue({ id: "owned", user_id: userId, metadata: { classification } });
      const service = new MemoryService(client, new StaticScopeResolver(scope), mockAuditSink());
      await service.delete("owned");
      expect(client.delete).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed on AuditSink failure for delete: upstream delete is never called", async () => {
    const client = mockClient();
    const service = new MemoryService(client, new StaticScopeResolver(scope), failingAuditSink());
    await expect(service.delete("owned")).rejects.toMatchObject({
      code: "governance_audit_unavailable",
    } satisfies Partial<GatewayError>);
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("never places Memory content in the DELETE audit event", async () => {
    const client = mockClient();
    vi.mocked(client.get).mockResolvedValue({ id: "owned", user_id: userId, memory: "sensitive private content" });
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await service.delete("owned");
    const serialized = JSON.stringify(audit.events[0]);
    expect(serialized).not.toContain("sensitive private content");
  });

  it("still verifies scope ownership before evaluating delete governance", async () => {
    const client = mockClient();
    vi.mocked(client.get).mockResolvedValue({ id: "foreign", user_id: "another-scope", metadata: { classification: "USER_DECISION" } });
    const audit = mockAuditSink();
    const service = new MemoryService(client, new StaticScopeResolver(scope), audit);
    await expect(service.delete("foreign")).rejects.toMatchObject({ code: "not_found" } satisfies Partial<GatewayError>);
    expect(client.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
