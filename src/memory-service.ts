import { createHash } from "node:crypto";
import { GatewayError } from "./errors.js";
import type { AuditSink } from "./governance/audit-sink.js";
import { detectHighConfidenceSecret, type SecretDetectionResult } from "./governance/secret-detection.js";
import type { GovernanceAuditEvent, GovernanceDecision, GovernanceWriteOperation } from "./governance/types.js";
import type { AddMemoryRequest, Mem0Client, SearchMemoryRequest, UpdateMemoryRequest } from "./mem0-client.js";
import { scopeFingerprint, scopeToMem0UserId, type ScopeResolver } from "./scope.js";

const RESERVED_METADATA_KEYS = new Set(["user_id", "agent_id", "run_id"]);
const SECRET_BLOCKED_MESSAGE = "Memory write blocked by governance policy.";
const AUDIT_UNAVAILABLE_MESSAGE = "Memory write could not be audited.";

export class MemoryService {
  constructor(
    private readonly client: Mem0Client,
    private readonly scopeResolver: ScopeResolver,
    private readonly auditSink: AuditSink,
  ) {}

  async add(input: Omit<AddMemoryRequest, "user_id">): Promise<unknown> {
    const userId = await this.currentUserId();
    validateMetadata(input.metadata);
    const secretResult = detectHighConfidenceSecret({
      texts: input.messages.map((message) => message.content),
      metadata: input.metadata,
    });
    await this.auditDecision({
      operation: "ADD",
      userId,
      secretResult,
      contentHashInput: { messages: input.messages, metadata: input.metadata },
    });
    return this.client.add({ ...input, user_id: userId });
  }

  async search(input: Omit<SearchMemoryRequest, "filters">): Promise<unknown> {
    const userId = await this.currentUserId();
    return this.client.search({ ...input, filters: { user_id: userId } });
  }

  async get(memoryId: string): Promise<unknown> {
    const userId = await this.currentUserId();
    return this.getOwned(memoryId, userId);
  }

  async update(memoryId: string, input: UpdateMemoryRequest): Promise<unknown> {
    const userId = await this.currentUserId();
    validateMetadata(input.metadata);
    // Secret check (and now the audit record) runs before the ownership
    // preflight (getOwned), which is itself a Mem0 call: a payload that
    // will be blocked regardless should not spend an extra upstream round
    // trip first. This ordering does not create a new ownership side
    // channel — the block decision depends only on the submitted payload,
    // never on whether memoryId exists or is owned by the caller, so the
    // response is identical either way. `memoryId` is only included in the
    // audit event on ALLOW (see auditDecision) so a BLOCK record never
    // pairs an unverified target id with a secret-detection outcome.
    const secretResult = detectHighConfidenceSecret({ texts: [input.text], metadata: input.metadata });
    await this.auditDecision({
      operation: "UPDATE",
      userId,
      secretResult,
      contentHashInput: { text: input.text, metadata: input.metadata },
      memoryId,
    });
    await this.getOwned(memoryId, userId);
    return this.client.update(memoryId, input);
  }

  async delete(memoryId: string): Promise<unknown> {
    const userId = await this.currentUserId();
    await this.getOwned(memoryId, userId);
    return this.client.delete(memoryId);
  }

  private async currentUserId(): Promise<string> {
    return scopeToMem0UserId(await this.scopeResolver.resolve());
  }

  private async getOwned(memoryId: string, expectedUserId: string): Promise<unknown> {
    const memory = await this.client.get(memoryId);
    const actualUserId = extractUserId(memory);
    if (actualUserId === undefined) {
      throw new GatewayError("upstream_contract_error", "Mem0 memory response lacks user_id");
    }
    if (actualUserId !== expectedUserId) {
      throw new GatewayError("not_found", "Memory not found");
    }
    return memory;
  }

  /**
   * Memory Write Governance (Phase 3A): records the ALLOW/BLOCK decision
   * before any Mem0 mutation call, and fails closed — throwing
   * `governance_audit_unavailable` without ever calling Mem0 — if the
   * AuditSink itself cannot persist the event. This is a governance
   * decision record, not an execution-outcome record: an ALLOW event means
   * policy did not block the write, not that the subsequent upstream call
   * is guaranteed to succeed (e.g. `update` can still fail ownership or
   * upstream checks afterward).
   *
   * `contentHash` is included only for ALLOW so a BLOCK record never
   * carries even a hash of secret-bearing content. `memoryId` is included
   * only for ALLOW so a BLOCK record never pairs an unverified target id
   * with a secret-detection outcome.
   */
  private async auditDecision(params: {
    operation: GovernanceWriteOperation;
    userId: string;
    secretResult: SecretDetectionResult;
    contentHashInput: unknown;
    memoryId?: string;
  }): Promise<void> {
    const decision: GovernanceDecision = params.secretResult.riskTier === "HIGH_CONFIDENCE" ? "BLOCK" : "ALLOW";
    const auditEvent: GovernanceAuditEvent = {
      timestamp: new Date().toISOString(),
      operation: params.operation,
      classification: "UNCLASSIFIED",
      decision,
      reasonCodes: params.secretResult.reasonCodes,
      scopeFingerprint: scopeFingerprint(params.userId),
      ...(decision === "ALLOW" ? { contentHash: hashForAudit(params.contentHashInput) } : {}),
      ...(decision === "ALLOW" && params.memoryId !== undefined ? { memoryId: params.memoryId } : {}),
    };

    try {
      await this.auditSink.record(auditEvent);
    } catch {
      throw new GatewayError("governance_audit_unavailable", AUDIT_UNAVAILABLE_MESSAGE, true);
    }

    if (decision === "BLOCK") {
      throw new GatewayError("secret_detected_high_confidence", SECRET_BLOCKED_MESSAGE, false);
    }
  }
}

function hashForAudit(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function extractUserId(memory: unknown): string | undefined {
  if (memory === null || typeof memory !== "object" || Array.isArray(memory)) return undefined;
  const userId = (memory as Record<string, unknown>).user_id;
  return typeof userId === "string" ? userId : undefined;
}

function validateMetadata(metadata: Record<string, unknown> | null | undefined): void {
  if (metadata === null || metadata === undefined) return;
  for (const key of Object.keys(metadata)) {
    if (RESERVED_METADATA_KEYS.has(key)) {
      throw new GatewayError("validation_error", `Metadata key '${key}' is reserved`);
    }
  }
}
