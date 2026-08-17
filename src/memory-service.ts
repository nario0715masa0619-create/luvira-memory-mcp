import { createHash } from "node:crypto";
import { GatewayError } from "./errors.js";
import type { AuditSink } from "./governance/audit-sink.js";
import { detectHighConfidenceSecret, type SecretDetectionResult } from "./governance/secret-detection.js";
import type {
  GovernanceAuditEvent,
  GovernanceDecision,
  GovernanceReasonCode,
  GovernanceWriteOperation,
  MemoryClassification,
  MemorySourceType,
  WriteIntent,
} from "./governance/types.js";
import type { AddMemoryRequest, Mem0Client, SearchMemoryRequest, UpdateMemoryRequest } from "./mem0-client.js";
import { scopeFingerprint, scopeToMem0UserId, type ScopeResolver } from "./scope.js";

const RESERVED_METADATA_KEYS = new Set(["user_id", "agent_id", "run_id"]);
const SECRET_BLOCKED_MESSAGE = "Memory write blocked by governance policy.";
const AUDIT_UNAVAILABLE_MESSAGE = "Memory write could not be audited.";
const DEFAULT_CLASSIFICATION: MemoryClassification = "UNCLASSIFIED";

/** Classifications a caller may never persist, regardless of explicit-request or content. */
const RESTRICTED_CLASSIFICATIONS = new Set<MemoryClassification>(["SECRET", "CUSTOMER_CONFIDENTIAL"]);

/**
 * Memory Write Governance (Phase 4): optional Classification / Provenance
 * input a caller may attach to a write. Every field here is a client
 * assertion, never Authority, never verified human approval, and never a
 * Gateway branch condition based on client identity — see
 * `governance/types.ts` for the Canonical types these map onto.
 */
export interface GovernanceWriteFields {
  classification?: MemoryClassification | undefined;
  source_type?: MemorySourceType | undefined;
  explicit_user_request?: boolean | undefined;
  source_project?: string | undefined;
  source_client?: string | undefined;
}

export class MemoryService {
  constructor(
    private readonly client: Mem0Client,
    private readonly scopeResolver: ScopeResolver,
    private readonly auditSink: AuditSink,
  ) {}

  async add(input: Omit<AddMemoryRequest, "user_id"> & GovernanceWriteFields): Promise<unknown> {
    const { classification, source_type, explicit_user_request, source_project, source_client, ...mem0Input } = input;
    const userId = await this.currentUserId();
    validateMetadata(mem0Input.metadata);
    const resolvedClassification = classification ?? DEFAULT_CLASSIFICATION;
    const secretResult = detectHighConfidenceSecret({
      texts: mem0Input.messages.map((message) => message.content),
      metadata: mem0Input.metadata,
    });
    await this.auditDecision({
      operation: "ADD",
      userId,
      classification: resolvedClassification,
      secretResult,
      contentHashInput: { messages: mem0Input.messages, metadata: mem0Input.metadata },
      sourceType: source_type,
      writeIntent: writeIntentFor(explicit_user_request),
      sourceProject: source_project,
      sourceClient: source_client,
    });

    // Only mirror governance annotations into Mem0-bound metadata when the
    // caller already gave a reason to touch metadata (they sent metadata,
    // or they sent at least one governance field). A plain call with
    // neither — the pre-Phase-4 calling style every existing client still
    // uses — must keep producing exactly the pre-Phase-4 `client.add`
    // payload; the Audit event above already records `classification:
    // "UNCLASSIFIED"` for it regardless.
    const hasGovernanceInput = classification !== undefined || source_type !== undefined
      || explicit_user_request !== undefined || source_project !== undefined || source_client !== undefined;
    const metadata = mem0Input.metadata !== undefined || hasGovernanceInput
      ? buildMem0Metadata(mem0Input.metadata ?? {}, {
        classification: resolvedClassification,
        source_type,
        explicit_user_request,
        source_project,
        source_client,
      })
      : undefined;
    return this.client.add({ ...mem0Input, metadata, user_id: userId });
  }

  async search(input: Omit<SearchMemoryRequest, "filters">): Promise<unknown> {
    const userId = await this.currentUserId();
    return this.client.search({ ...input, filters: { user_id: userId } });
  }

  async get(memoryId: string): Promise<unknown> {
    const userId = await this.currentUserId();
    return this.getOwned(memoryId, userId);
  }

  async update(memoryId: string, input: UpdateMemoryRequest & GovernanceWriteFields): Promise<unknown> {
    const { classification, source_type, explicit_user_request, source_project, source_client, ...mem0Input } = input;
    const userId = await this.currentUserId();
    validateMetadata(mem0Input.metadata);
    const resolvedClassification = classification ?? DEFAULT_CLASSIFICATION;
    // Secret check (and the audit record) runs before the ownership
    // preflight (getOwned), which is itself a Mem0 call: a payload that
    // will be blocked regardless should not spend an extra upstream round
    // trip first. This ordering does not create a new ownership side
    // channel — the block decision depends only on the submitted payload,
    // never on whether memoryId exists or is owned by the caller, so the
    // response is identical either way. `memoryId` is only included in the
    // audit event on ALLOW (see auditDecision) so a BLOCK record never
    // pairs an unverified target id with a secret-detection outcome.
    const secretResult = detectHighConfidenceSecret({ texts: [mem0Input.text], metadata: mem0Input.metadata });
    await this.auditDecision({
      operation: "UPDATE",
      userId,
      classification: resolvedClassification,
      secretResult,
      contentHashInput: { text: mem0Input.text, metadata: mem0Input.metadata },
      memoryId,
      sourceType: source_type,
      writeIntent: writeIntentFor(explicit_user_request),
      sourceProject: source_project,
      sourceClient: source_client,
    });
    await this.getOwned(memoryId, userId);

    // Unlike `add`, an update's `metadata` field carries meaning by
    // presence: `undefined` means "leave existing metadata untouched" and
    // `null` means "clear it". Governance annotations are only merged in
    // when the caller is already sending a metadata object this call, so
    // neither of those two existing semantics is disturbed.
    const metadata = mem0Input.metadata && typeof mem0Input.metadata === "object"
      ? buildMem0Metadata(mem0Input.metadata, {
        classification: resolvedClassification,
        source_type,
        explicit_user_request,
        source_project,
        source_client,
      })
      : mem0Input.metadata;
    return this.client.update(memoryId, { ...mem0Input, metadata });
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
   * Memory Write Governance (Phase 3A / Phase 4): records the ALLOW/BLOCK
   * decision before any Mem0 mutation call, and fails closed — throwing
   * `governance_audit_unavailable` without ever calling Mem0 — if the
   * AuditSink itself cannot persist the event. This is a governance
   * decision record, not an execution-outcome record: an ALLOW event means
   * policy did not block the write, not that the subsequent upstream call
   * is guaranteed to succeed (e.g. `update` can still fail ownership or
   * upstream checks afterward).
   *
   * Two independent block gates are evaluated, checked in this order:
   * 1. `classification` is SECRET or CUSTOMER_CONFIDENTIAL (Phase 4,
   *    minimal safety exception carried over from the approved Memory
   *    Classification Model — not risk-tiered Automation Policy).
   * 2. High-confidence pattern-based secret detection (Phase 3).
   * A caller cannot use one to bypass the other: declaring an innocuous
   * classification never suppresses pattern-based detection, and declaring
   * a safe-looking payload never suppresses the classification restriction.
   *
   * `contentHash` and `memoryId` are included only on ALLOW (see Phase 3A).
   * `sourceType` / `writeIntent` / `sourceProject` / `sourceClient` carry no
   * content or secret material, so they are recorded on both ALLOW and
   * BLOCK when the caller supplied them.
   */
  private async auditDecision(params: {
    operation: GovernanceWriteOperation;
    userId: string;
    classification: MemoryClassification;
    secretResult: SecretDetectionResult;
    contentHashInput: unknown;
    memoryId?: string | undefined;
    sourceType?: MemorySourceType | undefined;
    writeIntent?: WriteIntent | undefined;
    sourceProject?: string | undefined;
    sourceClient?: string | undefined;
  }): Promise<void> {
    const classificationRestricted = RESTRICTED_CLASSIFICATIONS.has(params.classification);
    const secretBlocked = params.secretResult.riskTier === "HIGH_CONFIDENCE";
    const decision: GovernanceDecision = classificationRestricted || secretBlocked ? "BLOCK" : "ALLOW";
    const reasonCodes: readonly GovernanceReasonCode[] = classificationRestricted
      ? ["classification_restricted"]
      : params.secretResult.reasonCodes;

    const auditEvent: GovernanceAuditEvent = {
      timestamp: new Date().toISOString(),
      operation: params.operation,
      classification: params.classification,
      decision,
      reasonCodes,
      scopeFingerprint: scopeFingerprint(params.userId),
      ...(decision === "ALLOW" ? { contentHash: hashForAudit(params.contentHashInput) } : {}),
      ...(decision === "ALLOW" && params.memoryId !== undefined ? { memoryId: params.memoryId } : {}),
      ...(params.sourceType !== undefined ? { sourceType: params.sourceType } : {}),
      ...(params.writeIntent !== undefined ? { writeIntent: params.writeIntent } : {}),
      ...(params.sourceProject !== undefined ? { sourceProject: params.sourceProject } : {}),
      ...(params.sourceClient !== undefined ? { sourceClient: params.sourceClient } : {}),
    };

    try {
      await this.auditSink.record(auditEvent);
    } catch {
      throw new GatewayError("governance_audit_unavailable", AUDIT_UNAVAILABLE_MESSAGE, true);
    }

    if (decision === "BLOCK") {
      const code = classificationRestricted ? "classification_restricted" : "secret_detected_high_confidence";
      throw new GatewayError(code, SECRET_BLOCKED_MESSAGE, false);
    }
  }
}

function writeIntentFor(explicitUserRequest: boolean | undefined): WriteIntent | undefined {
  if (explicitUserRequest === undefined) return undefined;
  return explicitUserRequest ? "EXPLICIT_REPORTED" : "IMPLICIT";
}

/**
 * Merges caller-supplied metadata with Gateway-computed governance
 * annotations for storage in Mem0. Gateway values always win on a key
 * collision — a caller cannot use a same-named metadata key (e.g.
 * `authority`) to override the canonical value the Gateway computes. Only
 * fields the caller actually supplied are added beyond `classification` /
 * `authority`, which are always present.
 */
function buildMem0Metadata(
  callerMetadata: Record<string, unknown>,
  governance: {
    classification: MemoryClassification;
    source_type: MemorySourceType | undefined;
    explicit_user_request: boolean | undefined;
    source_project: string | undefined;
    source_client: string | undefined;
  },
): Record<string, unknown> {
  return {
    ...callerMetadata,
    classification: governance.classification,
    authority: "supplemental",
    ...(governance.source_type !== undefined ? { source_type: governance.source_type } : {}),
    ...(governance.explicit_user_request !== undefined ? { explicit_user_request: governance.explicit_user_request } : {}),
    ...(governance.source_project !== undefined ? { source_project: governance.source_project } : {}),
    ...(governance.source_client !== undefined ? { source_client: governance.source_client } : {}),
  };
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
