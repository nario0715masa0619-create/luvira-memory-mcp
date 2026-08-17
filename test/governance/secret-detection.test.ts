import { describe, expect, it } from "vitest";
import { detectHighConfidenceSecret } from "../../src/governance/secret-detection.js";

// All fixture values below are fake or well-known public documentation
// examples (AWS's own "AKIAIOSFODNN7EXAMPLE" / "wJalr...EXAMPLEKEY" pair,
// jwt.io's public sample JWT). None are real, active credentials.
const FAKE_AWS_SECRET_ACCESS_KEY = "zK9mQpR3vT7wXcB2nL8jH5fD1sA6gY4eN0uIvz1";

describe("detectHighConfidenceSecret — true positives", () => {
  it.each([
    ["PEM private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n-----END PRIVATE KEY-----"],
    ["PEM RSA private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"],
    ["PEM OPENSSH private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----"],
    ["GitHub classic token", "token: ghp_1234567890abcdefghijklmnopqrstuvwxyz"],
    ["GitHub fine-grained token", "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJK"],
    ["JWT (jwt.io public sample)", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
    ["Bearer with token-shaped value", "Authorization: Bearer a1b2c3d4e5f6g7h8i9j0k1l2"],
    ["password assignment (colon)", "password: SuperSecretValue123"],
    ["password assignment (equals, quoted)", 'password="Sup3rSecretPhrase"'],
    ["AWS_SECRET_ACCESS_KEY assignment alone", `AWS_SECRET_ACCESS_KEY=${FAKE_AWS_SECRET_ACCESS_KEY}`],
    ["aws_secret_access_key assignment (lowercase, colon)", `aws_secret_access_key: ${FAKE_AWS_SECRET_ACCESS_KEY}`],
    ["AWS Access Key ID + Secret Access Key pair", `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=${FAKE_AWS_SECRET_ACCESS_KEY}`],
  ])("flags %s as HIGH_CONFIDENCE", (_label, text) => {
    const result = detectHighConfidenceSecret({ texts: [text] });
    expect(result).toEqual({ riskTier: "HIGH_CONFIDENCE", reasonCodes: ["secret_detected_high_confidence"] });
  });

  it("detects a secret nested inside metadata values", () => {
    const result = detectHighConfidenceSecret({
      metadata: { nested: { deep: ["ok", "ghp_1234567890abcdefghijklmnopqrstuvwxyz"] } },
    });
    expect(result.riskTier).toBe("HIGH_CONFIDENCE");
  });

  it("detects a secret in messages content when metadata is clean", () => {
    const result = detectHighConfidenceSecret({
      texts: ["ordinary line", "ghp_1234567890abcdefghijklmnopqrstuvwxyz"],
      metadata: { note: "nothing here" },
    });
    expect(result.riskTier).toBe("HIGH_CONFIDENCE");
  });
});

describe("detectHighConfidenceSecret — false positives (must stay NORMAL)", () => {
  it.each([
    ["the words 'API key'", "Please rotate your API key regularly."],
    ["the phrase 'Bearer token'", "This endpoint requires a Bearer token for authentication."],
    ["'password is required' prose", "A password is required to continue."],
    ["'password field' prose", "Leave the password field empty to skip."],
    ["an env var name alone", "LUVIRA_MCP_API_KEY"],
    ["a shell placeholder reference", "${OPENROUTER_KEY}"],
    ["angle-bracket placeholder", "<API_KEY>"],
    ["YOUR_API_KEY placeholder", "Set YOUR_API_KEY before starting."],
    ["a SHA-256 hash", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["a UUID", "550e8400-e29b-41d4-a716-446655440000"],
    ["a Memory-ID-shaped string", "9f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8"],
    ["ordinary prose about auth", "This document explains how our authentication system works using bearer tokens and API keys for secure access."],
    ["a code snippet explaining env vars", "# Set LUVIRA_MCP_API_KEY and OPENROUTER_KEY in your .env file before running the server."],
    ["sk-example placeholder", "Use sk-example as a stand-in in the docs."],
    ["test-token placeholder", "The fixture uses test-token as a stand-in value."],
    ["dummy-secret placeholder", "This is a dummy-secret used only in unit tests."],
    ["password with placeholder value (angle bracket)", "password: <password>"],
    ["password with placeholder value (YOUR_)", "password=YOUR_PASSWORD_HERE"],
    ["password with short value", "password=ab"],
    ["short GitHub-prefixed string", "ghp_test123"],
    ["Bearer with short/non-digit value", "Bearer implementation-details-explained"],
    ["JWT-looking but too-short segments", "eyJ.a.b"],
    ["bare AWS Access Key ID (identifier only, no secret)", "AKIAIOSFODNN7EXAMPLE"],
    ["AWS_ACCESS_KEY_ID assignment alone (no secret key present)", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"],
    [
      "AWS official example pair (both values contain the EXAMPLE marker)",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ],
    ["generic 40-character random-looking string with no credential context", "zK9mQpR3vT7wXcB2nL8jH5fD1sA6gY4eN0uIvz1x2y3"],
    ["aws_secret_access_key placeholder value", "aws_secret_access_key=YOUR_SECRET_KEY_HERE"],
  ])("does not flag %s", (_label, text) => {
    const result = detectHighConfidenceSecret({ texts: [text] });
    expect(result).toEqual({ riskTier: "NORMAL", reasonCodes: [] });
  });

  it("ignores non-string metadata values", () => {
    const result = detectHighConfidenceSecret({
      metadata: { count: 42, active: true, note: null, tags: ["fine", "also fine"] },
    });
    expect(result.riskTier).toBe("NORMAL");
  });

  it("returns NORMAL for empty input", () => {
    expect(detectHighConfidenceSecret({})).toEqual({ riskTier: "NORMAL", reasonCodes: [] });
  });
});

describe("detectHighConfidenceSecret — result safety", () => {
  it("never echoes the matched value back in the result", () => {
    const secretValue = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const result = detectHighConfidenceSecret({ texts: [secretValue] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain("ghp_");
  });
});
