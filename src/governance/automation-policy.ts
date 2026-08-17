import type { GovernanceReasonCode, MemoryClassification, WriteIntent } from "./types.js";

/**
 * Automation Policy (Memory Governance MVP): decides whether a write may
 * proceed automatically, based only on `classification` and `writeIntent`.
 *
 * Decision model is ALLOW/BLOCK only — `REVIEW_REQUIRED` is deliberately
 * not produced here. The Gateway has no verified human-approval channel
 * (see `authority-and-permission.md` in `luvira-os`), so a "review" outcome
 * with nothing that can ever complete the review would be an indefinite
 * BLOCK wearing a misleading label. When human involvement is warranted,
 * this module says so through BLOCK + a reason code, not through a
 * decision type nobody can resolve.
 *
 * This module is intentionally narrow, matching `secret-detection.ts`:
 * - no Mem0 / network calls
 * - no logging
 * - no AuditSink calls
 * - no filesystem I/O
 * - no branching on client identity (no `source_client` input at all)
 * - pure and deterministic
 */

export interface AutomationPolicyResult {
  readonly allowed: boolean;
  readonly reasonCodes: readonly GovernanceReasonCode[];
}

/**
 * Classifications whose entire value is "this represents a decision or
 * policy a human is understood to stand behind". An AI persisting one of
 * these on its own initiative (no explicit user request) is exactly the
 * hallucinated-decision-persistence scenario Automation Policy exists to
 * stop. Requires `WriteIntent.EXPLICIT_REPORTED`.
 *
 * Exported so `memory-service.ts` can reuse the same set for the UPDATE
 * downgrade-protection and DELETE protection checks — those are a
 * different mechanism (comparing against a Memory's *existing* stored
 * classification) but must agree on which classifications count as
 * protected, or a caller could use one check to defeat the other.
 */
export const REQUIRES_EXPLICIT_CLASSIFICATIONS: ReadonlySet<MemoryClassification> = new Set([
  "USER_DECISION",
  "ORGANIZATION_POLICY",
  "PROJECT_DECISION",
]);

/**
 * Content whose own classification already flags it as untrusted-origin.
 * An implicit (AI-initiated) write of EXTERNAL_UNTRUSTED content is the
 * textbook prompt-injection-persistence path — the trust signal and the
 * lack of a human request compound. Requires `WriteIntent.EXPLICIT_REPORTED`.
 */
const REQUIRES_EXPLICIT_UNTRUSTED: ReadonlySet<MemoryClassification> = new Set(["EXTERNAL_UNTRUSTED"]);

const ALLOW: AutomationPolicyResult = { allowed: true, reasonCodes: [] };

/**
 * `classification` here is the *effective* classification the caller
 * should evaluate — for ADD that is simply the declared/default
 * classification; for UPDATE, `memory-service.ts` is responsible for
 * folding in the target Memory's existing classification first (this
 * module has no notion of "existing" anything). `writeIntent` is
 * `undefined` for the omitted case — every existing/legacy caller that
 * does not send `explicit_user_request` lands here, and every
 * classification not explicitly named below stays ALLOW for it.
 */
export function evaluateAutomationPolicy(
  classification: MemoryClassification,
  writeIntent: WriteIntent | undefined,
): AutomationPolicyResult {
  if (writeIntent === "EXPLICIT_REPORTED") return ALLOW;

  if (REQUIRES_EXPLICIT_CLASSIFICATIONS.has(classification)) {
    return { allowed: false, reasonCodes: ["automation_policy_restricted"] };
  }
  if (REQUIRES_EXPLICIT_UNTRUSTED.has(classification)) {
    return { allowed: false, reasonCodes: ["untrusted_source"] };
  }
  return ALLOW;
}
