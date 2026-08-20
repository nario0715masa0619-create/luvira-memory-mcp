import { createHash } from "node:crypto";
import { evaluateAutomationPolicy, REQUIRES_EXPLICIT_CLASSIFICATIONS } from "./governance/automation-policy.js";
import { GatewayError, type GatewayErrorCode } from "./errors.js";
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
const GOVERNANCE_BLOCKED_MESSAGE = "Memory write blocked by governance policy.";
const AUDIT_UNAVAILABLE_MESSAGE = "Memory write could not be audited.";
const INFER_NOT_ALLOWED_MESSAGE = "Memory write with infer=true is not allowed by governance policy.";
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

/** Outcome of the pre-mutation governance evaluation shared by ADD/UPDATE. */
interface WriteGovernanceVerdict {
  readonly decision: GovernanceDecision;
  readonly reasonCodes: readonly GovernanceReasonCode[];
  readonly errorCode: GatewayErrorCode | null;
  readonly errorMessage: string;
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
    const writeIntent = writeIntentFor(explicit_user_request);

    // Memory Governance MVP (AR-1): `infer=true` lets Mem0 opaquely
    // merge/update/remove memories server-side. The Gateway cannot audit
    // that mutation before it happens, so it is rejected unconditionally
    // and unconditionally-first — cheaper than the secret scan, and this
    // block does not depend on payload content at all.
    if (mem0Input.infer === true) {
      await this.auditAndMaybeThrow({
        operation: "ADD",
        userId,
        classification: resolvedClassification,
        decision: "BLOCK",
        reasonCodes: ["opaque_upstream_mutation_not_allowed"],
        errorCode: "opaque_upstream_mutation_not_allowed",
        errorMessage: INFER_NOT_ALLOWED_MESSAGE,
        sourceType: source_type,
        writeIntent,
        sourceProject: source_project,
        sourceClient: source_client,
      });
    }

    const secretResult = detectHighConfidenceSecret({
      texts: mem0Input.messages.map((message) => message.content),
      metadata: mem0Input.metadata,
    });
    const verdict = this.evaluateWriteGovernance(resolvedClassification, writeIntent, secretResult);
    await this.auditAndMaybeThrow({
      operation: "ADD",
      userId,
      classification: resolvedClassification,
      decision: verdict.decision,
      reasonCodes: verdict.reasonCodes,
      errorCode: verdict.errorCode,
      errorMessage: verdict.errorMessage,
      contentHashInput: verdict.decision === "ALLOW" ? { messages: mem0Input.messages, metadata: mem0Input.metadata } : undefined,
      sourceType: source_type,
      writeIntent,
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
    const declaredClassification = classification ?? DEFAULT_CLASSIFICATION;
    const writeIntent = writeIntentFor(explicit_user_request);

    // Secret detection and the SECRET/CUSTOMER_CONFIDENTIAL restriction do
    // not depend on any existing state, so — as in Phase 3A — they are
    // evaluated and, if they block, audited and thrown before any Mem0
    // call at all (ownership included). Automation Policy is different: it
    // must also consider the target Memory's *existing* classification (see
    // effectiveClassificationFor below), which requires the ownership read
    // (getOwned) to have already happened. That read was always required
    // for a surviving update regardless, so this costs nothing extra for
    // the common case; it only means an automation-policy BLOCK, unlike a
    // secret/classification-restriction BLOCK, is preceded by one Mem0 GET
    // (never a Mem0 write).
    const secretResult = detectHighConfidenceSecret({ texts: [mem0Input.text], metadata: mem0Input.metadata });
    const earlyVerdict = this.evaluateEarlyGates(declaredClassification, secretResult);
    if (earlyVerdict.decision === "BLOCK") {
      await this.auditAndMaybeThrow({
        operation: "UPDATE",
        userId,
        classification: declaredClassification,
        decision: earlyVerdict.decision,
        reasonCodes: earlyVerdict.reasonCodes,
        errorCode: earlyVerdict.errorCode,
        errorMessage: earlyVerdict.errorMessage,
        sourceType: source_type,
        writeIntent,
        sourceProject: source_project,
        sourceClient: source_client,
      });
    }

    const existing = await this.getOwned(memoryId, userId);
    const effectiveClassification = effectiveClassificationFor(declaredClassification, extractClassification(existing));
    const policy = evaluateAutomationPolicy(effectiveClassification, writeIntent);
    const decision: GovernanceDecision = policy.allowed ? "ALLOW" : "BLOCK";
    await this.auditAndMaybeThrow({
      operation: "UPDATE",
      userId,
      classification: declaredClassification,
      decision,
      reasonCodes: policy.reasonCodes,
      errorCode: policy.allowed ? null : "automation_policy_restricted",
      errorMessage: GOVERNANCE_BLOCKED_MESSAGE,
      contentHashInput: decision === "ALLOW" ? { text: mem0Input.text, metadata: mem0Input.metadata } : undefined,
      memoryId: decision === "ALLOW" ? memoryId : undefined,
      sourceType: source_type,
      writeIntent,
      sourceProject: source_project,
      sourceClient: source_client,
    });

    // Unlike `add`, an update's `metadata` field carries meaning by
    // presence: `undefined` means "leave existing metadata untouched" and
    // `null` means "clear it". Governance annotations are only merged in
    // when the caller is already sending a metadata object this call, so
    // neither of those two existing semantics is disturbed.
    const metadata = mem0Input.metadata && typeof mem0Input.metadata === "object"
      ? buildMem0Metadata(mem0Input.metadata, {
        classification: declaredClassification,
        source_type,
        explicit_user_request,
        source_project,
        source_client,
      })
      : mem0Input.metadata;
    return this.client.update(memoryId, { ...mem0Input, metadata });
  }

  async delete(memoryId: string, options: { explicitUserRequest?: boolean | undefined } = {}): Promise<unknown> {
    const userId = await this.currentUserId();
    const existing = await this.getOwned(memoryId, userId);
    const existingClassification = extractClassification(existing);
    const writeIntent = writeIntentFor(options.explicitUserRequest);

    // DELETE MVP protection (distinct from ADD/UPDATE): only classifications
    // that represent a human-standing decision are protected here, and only
    // against *implicit* deletion. SECRET/CUSTOMER_CONFIDENTIAL are
    // deliberately NOT protected the way ADD blocks them outright — legacy
    // secret-classified records may legitimately need deletion, and
    // blocking that would work against the goal of getting them out of
    // Mem0. Ownership is already verified by getOwned above regardless of
    // this decision.
    const isProtected = existingClassification !== undefined
      && REQUIRES_EXPLICIT_CLASSIFICATIONS.has(existingClassification as MemoryClassification);
    const decision: GovernanceDecision = isProtected && writeIntent !== "EXPLICIT_REPORTED" ? "BLOCK" : "ALLOW";

    await this.auditAndMaybeThrow({
      operation: "DELETE",
      userId,
      classification: (existingClassification as MemoryClassification | undefined) ?? "LEGACY_UNKNOWN",
      decision,
      reasonCodes: decision === "BLOCK" ? ["automation_policy_restricted"] : [],
      errorCode: decision === "BLOCK" ? "automation_policy_restricted" : null,
      errorMessage: GOVERNANCE_BLOCKED_MESSAGE,
      memoryId,
      writeIntent,
    });

    return this.client.delete(memoryId);
  }

  private async currentUserId(): Promise<string> {
    return scopeToMem0UserId(await this.scopeResolver.resolve());
  }

  private async getOwned(memoryId: string, expectedUserId: string): Promise<unknown> {
    const memory = await this.client.get(memoryId);
    // Mem0's GET returns HTTP 200 with a `null` body for a nonexistent or
    // already-deleted memory (it only maps to HTTP 404 on DELETE/PUT, not
    // GET) — this is Mem0's well-defined not-found shape, not a broken
    // response, so it belongs with the other not_found cases below rather
    // than upstream_contract_error. A non-null response missing `user_id`
    // is a separate, genuine contract violation and must stay distinct.
    if (memory === null) {
      throw new GatewayError("not_found", "Memory not found");
    }
    const actualUserId = extractUserId(memory);
    if (actualUserId === undefined) {
      throw new GatewayError("upstream_contract_error", "Mem0 memory response lacks user_id");
    }
    if (actualUserId !== expectedUserId) {
      throw new GatewayError("not_found", "Memory not found");
    }
    return memory;
  }

  /** Classification-restriction and secret-detection checks only — no existing-state dependency. */
  private evaluateEarlyGates(
    classification: MemoryClassification,
    secretResult: SecretDetectionResult,
  ): WriteGovernanceVerdict {
    if (RESTRICTED_CLASSIFICATIONS.has(classification)) {
      return {
        decision: "BLOCK",
        reasonCodes: ["classification_restricted"],
        errorCode: "classification_restricted",
        errorMessage: GOVERNANCE_BLOCKED_MESSAGE,
      };
    }
    if (secretResult.riskTier === "HIGH_CONFIDENCE") {
      return {
        decision: "BLOCK",
        reasonCodes: secretResult.reasonCodes,
        errorCode: "secret_detected_high_confidence",
        errorMessage: GOVERNANCE_BLOCKED_MESSAGE,
      };
    }
    return { decision: "ALLOW", reasonCodes: [], errorCode: null, errorMessage: "" };
  }

  /** Full ADD governance: early gates, then Automation Policy. */
  private evaluateWriteGovernance(
    classification: MemoryClassification,
    writeIntent: WriteIntent | undefined,
    secretResult: SecretDetectionResult,
  ): WriteGovernanceVerdict {
    const early = this.evaluateEarlyGates(classification, secretResult);
    if (early.decision === "BLOCK") return early;

    const policy = evaluateAutomationPolicy(classification, writeIntent);
    if (!policy.allowed) {
      return {
        decision: "BLOCK",
        reasonCodes: policy.reasonCodes,
        errorCode: "automation_policy_restricted",
        errorMessage: GOVERNANCE_BLOCKED_MESSAGE,
      };
    }
    return { decision: "ALLOW", reasonCodes: [], errorCode: null, errorMessage: "" };
  }

  /**
   * Memory Write Governance (Phase 3A onward): records the decision before
   * any Mem0 mutation call, and fails closed — throwing
   * `governance_audit_unavailable` without ever calling Mem0 — if the
   * AuditSink itself cannot persist the event. This is a governance
   * decision record, not an execution-outcome record: an ALLOW event means
   * policy did not block the write, not that a subsequent upstream call is
   * guaranteed to succeed.
   *
   * `contentHash` / `memoryId` are supplied by the caller only when they
   * are safe to record (see Phase 3A/4 reasoning at each call site) — this
   * method does not decide that on their behalf.
   */
  private async auditAndMaybeThrow(params: {
    operation: GovernanceWriteOperation;
    userId: string;
    classification: MemoryClassification;
    decision: GovernanceDecision;
    reasonCodes: readonly GovernanceReasonCode[];
    errorCode: GatewayErrorCode | null;
    errorMessage: string;
    contentHashInput?: unknown;
    memoryId?: string | undefined;
    sourceType?: MemorySourceType | undefined;
    writeIntent?: WriteIntent | undefined;
    sourceProject?: string | undefined;
    sourceClient?: string | undefined;
  }): Promise<void> {
    const auditEvent: GovernanceAuditEvent = {
      timestamp: new Date().toISOString(),
      operation: params.operation,
      classification: params.classification,
      decision: params.decision,
      reasonCodes: params.reasonCodes,
      scopeFingerprint: scopeFingerprint(params.userId),
      ...(params.contentHashInput !== undefined ? { contentHash: hashForAudit(params.contentHashInput) } : {}),
      ...(params.memoryId !== undefined ? { memoryId: params.memoryId } : {}),
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

    if (params.decision === "BLOCK" && params.errorCode !== null) {
      throw new GatewayError(params.errorCode, params.errorMessage, false);
    }
  }
}

function writeIntentFor(explicitUserRequest: boolean | undefined): WriteIntent | undefined {
  if (explicitUserRequest === undefined) return undefined;
  return explicitUserRequest ? "EXPLICIT_REPORTED" : "IMPLICIT";
}

/**
 * UPDATE downgrade-protection: a caller cannot defeat Automation Policy on
 * a protected existing Memory by declaring a weaker `classification` (or
 * none) on the update. If the existing record is protected, its
 * classification is what Automation Policy evaluates; otherwise the
 * caller's declared (or default) classification is used, same as ADD.
 */
function effectiveClassificationFor(
  declared: MemoryClassification,
  existing: string | undefined,
): MemoryClassification {
  if (existing !== undefined && REQUIRES_EXPLICIT_CLASSIFICATIONS.has(existing as MemoryClassification)) {
    return existing as MemoryClassification;
  }
  return declared;
}

/**
 * Reads a Memory's previously-stored classification back from Mem0's
 * response (`metadata.classification`, the same key `buildMem0Metadata`
 * writes). Returns `undefined` — never a guess — when absent or not a
 * string: most existing/legacy records, or anything not written by this
 * Gateway's Phase 4+ code, will not have this field.
 */
function extractClassification(memory: unknown): string | undefined {
  if (memory === null || typeof memory !== "object") return undefined;
  const metadata = (memory as Record<string, unknown>).metadata;
  if (metadata === null || typeof metadata !== "object") return undefined;
  const classification = (metadata as Record<string, unknown>).classification;
  return typeof classification === "string" ? classification : undefined;
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
