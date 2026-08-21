import { describe, expect, it } from "vitest";
import type {
  GovernanceAuditEvent,
  MemoryAuthorityLevel,
  MemoryClassification,
  MemorySourceType,
  MemoryTrustLevel,
  WriteIntent,
} from "../../src/governance/types.js";

const CLASSIFICATIONS: readonly MemoryClassification[] = [
  "USER_PREFERENCE",
  "USER_DECISION",
  "ORGANIZATION_POLICY",
  "PROJECT_DECISION",
  "PROJECT_FACT",
  "WORKFLOW_STATE",
  "LONG_TERM_KNOWLEDGE",
  "TEMPORARY_CONTEXT",
  "EXTERNAL_UNTRUSTED",
  "SECRET",
  "CUSTOMER_CONFIDENTIAL",
  "UNCLASSIFIED",
  "LEGACY_UNKNOWN",
];

const SOURCE_TYPES: readonly MemorySourceType[] = [
  "USER_EXPLICIT",
  "AI_IMPLICIT",
  "EXTERNAL_UNTRUSTED",
  "SYSTEM",
  "LEGACY_UNKNOWN",
];

const TRUST_LEVELS: readonly MemoryTrustLevel[] = ["TRUSTED", "UNTRUSTED", "UNKNOWN"];
const WRITE_INTENTS: readonly WriteIntent[] = ["EXPLICIT_REPORTED", "IMPLICIT"];

// Sample fully-populated event used only to assert the field set at runtime;
// values are placeholders, never real Memory content.
const sampleAuditEvent: GovernanceAuditEvent = {
  timestamp: "2026-01-01T00:00:00.000Z",
  requestId: "req-1",
  operation: "ADD",
  memoryId: "mem-1",
  contentHash: "deadbeef",
  classification: "UNCLASSIFIED",
  decision: "ALLOW",
  reasonCodes: [],
  scopeFingerprint: "fingerprint",
  sourceType: "USER_EXPLICIT",
  writeIntent: "EXPLICIT_REPORTED",
  sourceProject: "luvira-memory-mcp",
  sourceClient: "claude-code",
  role: "read_write",
  credentialFingerprint: "fingerprint",
};

const FORBIDDEN_AUDIT_FIELD_PATTERN = /text|content$|raw|credential|secret|password|authorization|token/i;
// contentHash and credentialFingerprint both trip the pattern above by name
// (it exists to catch fields that could carry raw sensitive values) but are
// deliberately safe: each is a one-way hash of something dangerous to log
// raw, never the value itself. See memory-service.ts / auth-registry.ts.
const ALLOWED_CONTENT_FIELD_EXCEPTION = new Set(["contentHash", "credentialFingerprint"]);

describe("governance canonical types", () => {
  it("declares the required classification set with no duplicates", () => {
    expect(new Set(CLASSIFICATIONS).size).toBe(CLASSIFICATIONS.length);
    expect(CLASSIFICATIONS).toEqual(
      expect.arrayContaining([
        "USER_PREFERENCE", "USER_DECISION", "ORGANIZATION_POLICY", "PROJECT_DECISION",
        "PROJECT_FACT", "WORKFLOW_STATE", "LONG_TERM_KNOWLEDGE", "TEMPORARY_CONTEXT",
        "EXTERNAL_UNTRUSTED", "SECRET", "CUSTOMER_CONFIDENTIAL", "UNCLASSIFIED", "LEGACY_UNKNOWN",
      ]),
    );
  });

  it("declares the required source type set", () => {
    expect(SOURCE_TYPES).toEqual(
      expect.arrayContaining(["USER_EXPLICIT", "AI_IMPLICIT", "EXTERNAL_UNTRUSTED", "SYSTEM", "LEGACY_UNKNOWN"]),
    );
  });

  it("declares the required trust level set", () => {
    expect(TRUST_LEVELS).toEqual(expect.arrayContaining(["TRUSTED", "UNTRUSTED", "UNKNOWN"]));
  });

  it("declares the required write intent set without an approval-sounding value", () => {
    expect(WRITE_INTENTS).toEqual(expect.arrayContaining(["EXPLICIT_REPORTED", "IMPLICIT"]));
    for (const intent of WRITE_INTENTS) {
      expect(intent).not.toMatch(/approved|approval|verified/i);
    }
  });

  it("fixes MemoryAuthorityLevel to the single supplemental value", () => {
    const level: MemoryAuthorityLevel = "SUPPLEMENTAL";
    expect(level).toBe("SUPPLEMENTAL");
    // @ts-expect-error MemoryAuthorityLevel must not accept a promoted/canonical value.
    const rejected: MemoryAuthorityLevel = "APPROVED";
    void rejected;
  });

  it("GovernanceAuditEvent carries no Memory body, credential, or secret field", () => {
    const keys = Object.keys(sampleAuditEvent);
    for (const key of keys) {
      if (ALLOWED_CONTENT_FIELD_EXCEPTION.has(key)) continue;
      expect(key, `unexpected audit field '${key}' looks like it could carry sensitive content`).not.toMatch(
        FORBIDDEN_AUDIT_FIELD_PATTERN,
      );
    }
  });
});
