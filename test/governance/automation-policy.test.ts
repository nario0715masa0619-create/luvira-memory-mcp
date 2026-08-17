import { describe, expect, it } from "vitest";
import {
  evaluateAutomationPolicy,
  REQUIRES_EXPLICIT_CLASSIFICATIONS,
} from "../../src/governance/automation-policy.js";
import type { MemoryClassification, WriteIntent } from "../../src/governance/types.js";

// Section 5.2 Final Policy Matrix, reproduced here as the executable
// specification. `undefined` writeIntent is the OMITTED state (every
// pre-Governance-MVP caller that never sends `explicit_user_request`).
const ALWAYS_ALLOW: readonly MemoryClassification[] = [
  "USER_PREFERENCE", "PROJECT_FACT", "WORKFLOW_STATE",
  "LONG_TERM_KNOWLEDGE", "TEMPORARY_CONTEXT", "UNCLASSIFIED",
];

const REQUIRES_EXPLICIT: readonly MemoryClassification[] = ["USER_DECISION", "ORGANIZATION_POLICY", "PROJECT_DECISION"];

// SECRET / CUSTOMER_CONFIDENTIAL are blocked unconditionally by
// `classification_restricted` in `memory-service.ts`, upstream of this
// module — a deliberate separation of concerns (an absolute, content-blind
// block vs. this module's classification x WriteIntent risk model).
// LEGACY_UNKNOWN is a read-time-only interpretation that this module's
// caller never actually passes in for a live write. This module correctly
// has no opinion on any of the three, so they read as ALLOW-for-everything
// from its own, narrower contract.
const NO_OPINION_HERE: readonly MemoryClassification[] = ["SECRET", "CUSTOMER_CONFIDENTIAL", "LEGACY_UNKNOWN"];

const WRITE_INTENTS: readonly (WriteIntent | undefined)[] = ["EXPLICIT_REPORTED", "IMPLICIT", undefined];

describe("evaluateAutomationPolicy — Final Policy Matrix (Memory Governance MVP)", () => {
  it("covers all 13 MemoryClassification values with no gaps or duplicates", () => {
    const all = [...ALWAYS_ALLOW, ...REQUIRES_EXPLICIT, ...NO_OPINION_HERE, "EXTERNAL_UNTRUSTED"];
    expect(new Set(all).size).toBe(13);
  });

  it.each(ALWAYS_ALLOW)("%s: ALLOW for EXPLICIT_REPORTED, IMPLICIT, and OMITTED", (classification) => {
    for (const writeIntent of WRITE_INTENTS) {
      expect(evaluateAutomationPolicy(classification, writeIntent)).toEqual({ allowed: true, reasonCodes: [] });
    }
  });

  it.each(REQUIRES_EXPLICIT)("%s: ALLOW only for EXPLICIT_REPORTED; BLOCK automation_policy_restricted otherwise", (classification) => {
    expect(evaluateAutomationPolicy(classification, "EXPLICIT_REPORTED")).toEqual({ allowed: true, reasonCodes: [] });
    for (const writeIntent of ["IMPLICIT", undefined] as const) {
      expect(evaluateAutomationPolicy(classification, writeIntent)).toEqual({
        allowed: false,
        reasonCodes: ["automation_policy_restricted"],
      });
    }
  });

  it("USER_DECISION is never implicit-ALLOWed (5.3 mandatory safety rule)", () => {
    expect(evaluateAutomationPolicy("USER_DECISION", "IMPLICIT").allowed).toBe(false);
    expect(evaluateAutomationPolicy("USER_DECISION", undefined).allowed).toBe(false);
  });

  it("EXTERNAL_UNTRUSTED: ALLOW only for EXPLICIT_REPORTED; BLOCK untrusted_source otherwise", () => {
    expect(evaluateAutomationPolicy("EXTERNAL_UNTRUSTED", "EXPLICIT_REPORTED")).toEqual({ allowed: true, reasonCodes: [] });
    for (const writeIntent of ["IMPLICIT", undefined] as const) {
      expect(evaluateAutomationPolicy("EXTERNAL_UNTRUSTED", writeIntent)).toEqual({
        allowed: false,
        reasonCodes: ["untrusted_source"],
      });
    }
  });

  it.each(NO_OPINION_HERE)("%s: ALLOW from this module alone (blocked elsewhere, not here)", (classification) => {
    for (const writeIntent of WRITE_INTENTS) {
      expect(evaluateAutomationPolicy(classification, writeIntent)).toEqual({ allowed: true, reasonCodes: [] });
    }
  });

  it("never returns REVIEW_REQUIRED or any decision type outside allowed/reasonCodes", () => {
    const result = evaluateAutomationPolicy("USER_DECISION", "IMPLICIT");
    expect(Object.keys(result).sort()).toEqual(["allowed", "reasonCodes"]);
  });

  it("is pure and deterministic: identical input always yields an equal result", () => {
    const a = evaluateAutomationPolicy("ORGANIZATION_POLICY", "IMPLICIT");
    const b = evaluateAutomationPolicy("ORGANIZATION_POLICY", "IMPLICIT");
    expect(a).toEqual(b);
  });
});

describe("REQUIRES_EXPLICIT_CLASSIFICATIONS (shared with UPDATE/DELETE protection)", () => {
  it("is exactly the three human-decision classifications", () => {
    expect(new Set(REQUIRES_EXPLICIT_CLASSIFICATIONS)).toEqual(
      new Set(["USER_DECISION", "ORGANIZATION_POLICY", "PROJECT_DECISION"]),
    );
  });
});
