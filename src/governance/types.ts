/**
 * Canonical Memory Write Governance type model.
 *
 * As of Phase 4, this is no longer types-only: `secret-detection.ts` (Phase
 * 3) and `memory-service.ts` (Phase 3A/4) both import and act on these
 * types, and `MemoryClassification` / `MemorySourceType` are now exposed
 * (as a restricted, validated subset — see `tools.ts`) through the
 * `memory_add` / `memory_update` MCP input schema. Defining a type here
 * still does not by itself activate enforcement beyond what each phase's
 * code explicitly wires up.
 *
 * Two invariants drove every type below and must be preserved by future
 * changes:
 *
 * 1. Memory is never Canonical Authority. See {@link MemoryAuthorityLevel}.
 * 2. A client's self-report of user intent is not verified human approval.
 *    See {@link WriteIntent} and {@link GovernanceDecision}.
 */

/**
 * Canonical classification of a Memory record's content.
 *
 * `UNCLASSIFIED` marks a new write that has not been given a classification
 * yet (Phase 1 backward-compatibility bucket). `LEGACY_UNKNOWN` marks an
 * existing Memory record created before classification existed; it is a
 * read-time/audit-time interpretation, never something written back onto the
 * stored record.
 */
export type MemoryClassification =
  | "USER_PREFERENCE"
  | "USER_DECISION"
  | "ORGANIZATION_POLICY"
  | "PROJECT_DECISION"
  | "PROJECT_FACT"
  | "WORKFLOW_STATE"
  | "LONG_TERM_KNOWLEDGE"
  | "TEMPORARY_CONTEXT"
  | "EXTERNAL_UNTRUSTED"
  | "SECRET"
  | "CUSTOMER_CONFIDENTIAL"
  | "UNCLASSIFIED"
  | "LEGACY_UNKNOWN";

/**
 * Where a write's content is reported to have originated.
 *
 * `USER_EXPLICIT` records that the calling client reported the write as an
 * explicit user request. It is a client-reported source event, not evidence
 * that a human approved the write — see {@link WriteIntent} for the same
 * caution applied to intent.
 */
export type MemorySourceType =
  | "USER_EXPLICIT"
  | "AI_IMPLICIT"
  | "EXTERNAL_UNTRUSTED"
  | "SYSTEM"
  | "LEGACY_UNKNOWN";

/**
 * How much the Gateway trusts the origin of a Memory's content.
 *
 * `TRUSTED` describes provenance confidence only. It does not imply
 * Canonical Authority — Memory authority is fixed at `"supplemental"`
 * regardless of trust level; see {@link MemoryAuthorityLevel}.
 */
export type MemoryTrustLevel = "TRUSTED" | "UNTRUSTED" | "UNKNOWN";

/**
 * Memory's standing relative to Canonical Authority (Git, an Approved
 * Specification, Canonical Project Documentation, or another canonical
 * source).
 *
 * This is intentionally a single-value type. Do not add `APPROVED`,
 * `CANONICAL`, or any value that would let a Memory record appear to
 * outrank a canonical source. A classification such as `ORGANIZATION_POLICY`
 * or `PROJECT_DECISION` describes what the content is about; it never
 * changes this value. Promoting Memory to Canonical Authority is out of
 * scope for this Gateway in every phase, not just Phase 1.
 */
export type MemoryAuthorityLevel = "SUPPLEMENTAL";

/**
 * Mutating operations that Write Governance decisions apply to.
 *
 * Deliberately excludes search/get: read operations are not subject to
 * Write Governance Decisions (Phase 1 requirement — read path stays
 * unaffected). See {@link GovernanceReadOperation} for the separate,
 * audit-only concept.
 */
export type GovernanceWriteOperation = "ADD" | "UPDATE" | "DELETE";

/**
 * Read operations, kept as a distinct type from
 * {@link GovernanceWriteOperation} so a future audit consumer that wants to
 * record read activity can never be confused with a write-governance gate.
 * Not used by any Phase 1 code path.
 */
export type GovernanceReadOperation = "SEARCH" | "GET";

/**
 * Outcome of a governance decision.
 *
 * `REVIEW_REQUIRED` is deliberately neutral. It does not claim the Gateway
 * requested, obtained, or verified human approval — no trusted approval
 * channel exists yet (see `authority-and-permission.md` in the `luvira-os`
 * repository for the equivalent, already-Deferred concept for Git write
 * authority). A future trusted approval channel may consume this decision
 * and turn it into an actual approval outcome; the Gateway does not assume
 * that will happen.
 */
export type GovernanceDecision = "ALLOW" | "BLOCK" | "REVIEW_REQUIRED";

/**
 * Canonical reason codes for a {@link GovernanceDecision}.
 *
 * Not all codes are reachable in Phase 1 — most of these are reserved for
 * the implementation phases that introduce the check they describe. Adding
 * a reason code here does not activate the corresponding check.
 */
export type GovernanceReasonCode =
  // Classification (Phase 3+)
  | "classification_unknown"
  // Classification-declared restriction (Phase 4): the caller's own
  // `classification` input was SECRET or CUSTOMER_CONFIDENTIAL. This is a
  // minimal, unconditional safety exception carried over from the approved
  // Architecture Resolution — not the start of risk-tiered Automation
  // Policy (that remains a later phase). Distinct from
  // `secret_detected_high_confidence` because the trigger here is the
  // caller's self-declaration, not pattern-based content detection; audit
  // readers should be able to tell the two apart.
  | "classification_restricted"
  // Automation Policy (Memory Governance MVP): classification × WriteIntent
  // required an explicit-reported write and did not get one. Distinct from
  // `classification_restricted` (an absolute, content-blind block) and from
  // `approval_channel_unavailable` (reserved for a future verified approval
  // channel — not used for this deterministic, no-channel-needed check).
  | "automation_policy_restricted"
  // Secret detection (Phase 3, AR-4)
  | "secret_detected_high_confidence"
  | "secret_suspected_review_required"
  // Mem0 `infer` governance (Memory Governance MVP, AR-1): `infer=true`
  // lets Mem0 opaquely merge/update/remove memories server-side, bypassing
  // Gateway audit-before-mutation. Blocked unconditionally in the MVP.
  | "opaque_upstream_mutation_not_allowed"
  | "opaque_upstream_mutation_possible"
  // Approval boundary (Phase 6-7, AR-2) — no trusted approval channel
  // exists, so this means the operation is blocked pending one, not that
  // approval was requested and denied.
  | "approval_channel_unavailable"
  // Trust (Phase 6, AR-3/threat G)
  | "untrusted_source"
  // Conflict detection (Phase 9)
  | "duplicate_conflict"
  // Provenance consistency (Phase 6+)
  | "invalid_provenance"
  // Future external policy engine (Phase 10)
  | "policy_unavailable"
  // Project-aware scope (Phase 8, AR-3)
  | "project_scope_unresolved"
  // Project-Aware Scope (Phase 3): the authenticated credential's role
  // (from the auth registry, never a client self-assertion) is read_only.
  | "role_forbidden_write"
  // Handoff Identity Safety (ADR-003, MVP duplicate prevention): ADD
  // blocked because a non-expired handoff already exists for this scope +
  // handoff_project_id. Best-effort, not atomic — see memory-service.ts.
  | "handoff_already_active"
  // Handoff Identity Safety (ADR-003, MVP duplicate prevention): UPDATE
  // blocked because it tried to move an existing Handoff-shaped record to a
  // different handoff_project_id. Identity is immutable after creation.
  | "handoff_identity_immutable";

/**
 * Confidence tier for pattern-based secret detection (AR-4). Not a claim of
 * comprehensive DLP coverage — see `docs/memory-governance.md` once written.
 */
export type SecretRiskTier = "HIGH_CONFIDENCE" | "POSSIBLE" | "NORMAL";

/**
 * Whether a write was reported as user-initiated or AI-initiated.
 *
 * `EXPLICIT_REPORTED` means the calling client reported that a user
 * explicitly asked for this write (e.g. "remember this"). It is a
 * client-reported assertion, not a verified approval — do not rename this
 * to anything containing "APPROVED" or treat it as equivalent to
 * `human_approved` / `authority_verified` in code, logs, or documentation.
 */
export type WriteIntent = "EXPLICIT_REPORTED" | "IMPLICIT";

/**
 * Input to a (future) governance decision. Carries only classification and
 * provenance metadata needed to decide — never the Memory's own text or any
 * secret value, so a `GovernanceContext` can be logged or passed to a
 * future external policy engine without redaction.
 *
 * `sourceProject` and `sourceClient` are provenance, not policy-branching
 * authority: the Gateway core stays client-agnostic (no code path may
 * change behavior because `sourceClient` is `"claude-code"` vs `"codex"`).
 * They exist so a decision can later be explained ("why was this
 * blocked/allowed"), not so a client can grant itself different rules than
 * another client.
 */
export interface GovernanceContext {
  readonly operation: GovernanceWriteOperation;
  readonly classification: MemoryClassification;
  readonly sourceType: MemorySourceType;
  readonly trustLevel: MemoryTrustLevel;
  readonly writeIntent: WriteIntent;
  readonly authorityLevel: MemoryAuthorityLevel;
  /** Provenance only — see interface-level doc comment. Not policy authority. */
  readonly sourceProject?: string;
  /** Provenance only — see interface-level doc comment. Never a branch condition. */
  readonly sourceClient?: string;
  /** Mirrors Mem0's `infer` request flag; carried for future AR-1 enforcement. */
  readonly infer?: boolean;
  /** Classification of the pre-existing record, populated on UPDATE/DELETE. */
  readonly existingMemoryClassification?: MemoryClassification;
  /** Populated once secret detection (Phase 3) has run. */
  readonly secretRiskTier?: SecretRiskTier;
}

/**
 * Output of a (future) governance decision. Safe to place directly into an
 * audit record: it carries the decision and why, never Memory text,
 * metadata values, or any secret.
 */
export interface GovernanceDecisionResult {
  readonly decision: GovernanceDecision;
  readonly reasonCodes: readonly GovernanceReasonCode[];
  readonly classification: MemoryClassification;
  readonly secretRiskTier?: SecretRiskTier;
}

/**
 * Shape for the Phase 2 `AuditSink` record. Defined now so later phases
 * share one Canonical shape; no `AuditSink` implementation exists yet and
 * nothing constructs this type in Phase 1.
 *
 * Deliberately has no field for Memory text, raw content, credentials,
 * secrets, an Authorization header, or raw metadata. Do not add one —
 * `contentHash` exists precisely so correlation is possible without
 * carrying the content itself.
 */
export interface GovernanceAuditEvent {
  readonly timestamp: string;
  readonly requestId?: string;
  readonly operation: GovernanceWriteOperation;
  readonly memoryId?: string;
  readonly contentHash?: string;
  readonly classification: MemoryClassification;
  readonly decision: GovernanceDecision;
  readonly reasonCodes: readonly GovernanceReasonCode[];
  readonly scopeFingerprint: string;
  readonly sourceType?: MemorySourceType;
  readonly writeIntent?: WriteIntent;
  /** Provenance only (Phase 4) — never a policy-branching input. See {@link GovernanceContext}. */
  readonly sourceProject?: string;
  /** Provenance only (Phase 4) — never a policy-branching input. See {@link GovernanceContext}. */
  readonly sourceClient?: string;
  /**
   * Project-Aware Scope (Phase 3): the authenticated credential's role,
   * resolved from the auth registry — never a client self-assertion, unlike
   * every other field on this event. Inlined as the literal union (rather
   * than importing `ClientRole` from `auth-registry.ts`) so the governance
   * module does not depend on the auth-registry module; the two must stay
   * the same two values.
   */
  readonly role: "read_only" | "read_write";
  /**
   * Project-Aware Scope (Phase 3): one-way hash of the Bearer token that
   * authenticated this request — never the raw token. Identifies which
   * credential made a call without the audit log ever holding a secret.
   */
  readonly credentialFingerprint: string;
}
