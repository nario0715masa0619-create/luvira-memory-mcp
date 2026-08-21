export type GatewayErrorCode =
  | "validation_error"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "upstream_contract_error"
  | "internal_error"
  // Memory Write Governance (Phase 3, AR-4): the write payload matched a
  // high-confidence secret pattern and was blocked before reaching Mem0.
  // The message shown to callers never includes the matched value.
  | "secret_detected_high_confidence"
  // Memory Write Governance (Phase 3A): the governance decision could not
  // be persisted to the AuditSink. Write is fail-closed in this case —
  // Mem0 is never called, regardless of whether the decision itself would
  // have been ALLOW or BLOCK.
  | "governance_audit_unavailable"
  // Memory Write Governance (Phase 4): the caller declared classification
  // SECRET or CUSTOMER_CONFIDENTIAL. Minimal safety exception, not
  // risk-tiered Automation Policy — see memory-service.ts.
  | "classification_restricted"
  // Memory Governance MVP: Automation Policy required an explicit-reported
  // write for this classification and did not get one.
  | "automation_policy_restricted"
  // Memory Governance MVP: `infer=true` was rejected because Mem0's
  // resulting opaque mutation cannot be audited before it happens.
  | "opaque_upstream_mutation_not_allowed"
  // Project-Aware Scope (Phase 3): the authenticated credential's role is
  // read_only. Independent of every other write-governance check above —
  // reachable even for a caller whose content and classification would
  // otherwise be ALLOWed.
  | "role_forbidden_write";

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
