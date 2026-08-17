import type { GovernanceReasonCode, SecretRiskTier } from "./types.js";

/**
 * HIGH_CONFIDENCE secret detection for write payloads.
 *
 * Scope discipline (Phase 3 / AR-4): this module recognizes a small,
 * explicitly-reviewed set of high-confidence secret shapes. It is not a
 * general-purpose DLP engine, does not attempt semantic or entropy-based
 * detection, and does not classify content as customer-confidential. Only
 * the categories below are implemented; no additional vendor-specific
 * formats were added beyond what was explicitly reviewed, to avoid pattern
 * proliferation and false positives.
 *
 * This module is intentionally narrow:
 * - no Mem0 / network calls
 * - no logging
 * - no AuditSink calls
 * - no governance decision beyond risk-tier classification
 * - no branching on client identity
 *
 * The result never carries the matched text, the field it came from, or the
 * surrounding value — only which risk tier was reached and a Canonical
 * reason code. Callers must not attempt to recover "what matched" from this
 * module; that is a deliberate constraint, not an omission.
 */

export interface SecretDetectionInput {
  /** Plain-text fields to scan, e.g. `messages[].content` or `text`. */
  readonly texts?: readonly (string | null | undefined)[];
  /** Arbitrary caller-supplied metadata; string leaf values are scanned. */
  readonly metadata?: Record<string, unknown> | null | undefined;
}

export interface SecretDetectionResult {
  readonly riskTier: SecretRiskTier;
  readonly reasonCodes: readonly GovernanceReasonCode[];
}

const NO_SECRET: SecretDetectionResult = { riskTier: "NORMAL", reasonCodes: [] };
const HIGH_CONFIDENCE_SECRET: SecretDetectionResult = {
  riskTier: "HIGH_CONFIDENCE",
  reasonCodes: ["secret_detected_high_confidence"],
};

const MAX_METADATA_DEPTH = 20;

/**
 * High-confidence patterns only. Each entry was chosen because it has a
 * near-zero false-positive rate on ordinary prose, documentation, and
 * placeholder text (see test/governance/secret-detection.test.ts for the
 * false-positive regression suite this was built against).
 */
const HIGH_CONFIDENCE_PATTERNS: readonly RegExp[] = [
  // 1. PEM private keys. Public keys are deliberately excluded — a public
  // key is not a secret.
  /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)?\s?PRIVATE KEY-----/,

  // 2. GitHub token formats, length-gated to the real issued length so
  // short placeholders like "ghp_test" or "ghp_xxx" cannot match.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{45,}\b/,

  // 3. AWS Access Key ID alone is deliberately NOT a HIGH_CONFIDENCE match.
  // It is an identifier, not a bearer secret — it only becomes usable for
  // authentication when paired with a Secret Access Key. See the explicit
  // `aws_secret_access_key` assignment rule below for what actually blocks.

  // 4. JWT: three dot-separated base64url segments, each long enough to
  // rule out a two/three-token fragment that merely starts with "eyJ".
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/,

  // 5. Bearer with a realistic token-shaped value: at least 16 chars of
  // token charset AND at least one digit. The digit requirement is what
  // keeps ordinary prose like "Bearer token" or "Bearer authentication
  // details" (both purely alphabetic) from matching, while real tokens
  // (base64/hex/opaque) almost always contain a digit.
  /\bBearer\s+(?=[A-Za-z0-9\-_.=]{16,}\b)[A-Za-z0-9\-_.=]*\d[A-Za-z0-9\-_.=]*\b/,
];

/** Placeholder-shaped values that must never be treated as a real secret. */
const PLACEHOLDER_VALUE = /^(<.*>|\$\{.*\}|your[_-]|xxx|test|dummy|example|changeme|placeholder|fake|sample)/i;

/**
 * 6. Explicit password assignment (`password = value` / `password: value`).
 * Requires key/value structure so prose like "password is required" or
 * "password field" (no `:`/`=`) never matches, and rejects placeholder or
 * too-short captured values.
 */
const PASSWORD_ASSIGNMENT = /\bpassword\s*[:=]\s*["']?([^\s"']{4,})["']?/gi;

/**
 * 3b. Explicit AWS Secret Access Key assignment (refines category 3 above,
 * not a new vendor category). An AWS Secret Access Key has no fixed prefix,
 * so — unlike the vendor-prefixed patterns above — it is only ever matched
 * when it appears under its own strong credential-name context
 * (`aws_secret_access_key` / `AWS_SECRET_ACCESS_KEY`). A bare 40-character
 * random-looking string is never enough on its own; that would be generic
 * entropy detection, which this module deliberately does not do. A bare
 * `AKIA...` Access Key ID co-occurring with this assignment is still
 * covered by this same rule, since the assignment alone is sufficient.
 */
const AWS_SECRET_KEY_ASSIGNMENT = /\baws_secret_access_key\s*[:=]\s*["']?([^\s"']{16,})["']?/gi;

/** AWS's own documentation examples embed "EXAMPLE" in both sample credentials. */
const AWS_EXAMPLE_MARKER = /example/i;

function matchesHighConfidencePattern(text: string): boolean {
  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  PASSWORD_ASSIGNMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PASSWORD_ASSIGNMENT.exec(text)) !== null) {
    const value = match[1] ?? "";
    if (value.length >= 6 && !PLACEHOLDER_VALUE.test(value)) {
      return true;
    }
  }

  AWS_SECRET_KEY_ASSIGNMENT.lastIndex = 0;
  while ((match = AWS_SECRET_KEY_ASSIGNMENT.exec(text)) !== null) {
    const value = match[1] ?? "";
    if (!PLACEHOLDER_VALUE.test(value) && !AWS_EXAMPLE_MARKER.test(value)) {
      return true;
    }
  }

  return false;
}

function collectMetadataStrings(value: unknown, depth: number, out: string[]): void {
  if (depth > MAX_METADATA_DEPTH) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMetadataStrings(item, depth + 1, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) collectMetadataStrings(nested, depth + 1, out);
  }
}

export function detectHighConfidenceSecret(input: SecretDetectionInput): SecretDetectionResult {
  const candidates: string[] = [];

  for (const text of input.texts ?? []) {
    if (typeof text === "string") candidates.push(text);
  }
  collectMetadataStrings(input.metadata ?? undefined, 0, candidates);

  for (const candidate of candidates) {
    if (matchesHighConfidencePattern(candidate)) {
      return HIGH_CONFIDENCE_SECRET;
    }
  }

  return NO_SECRET;
}
