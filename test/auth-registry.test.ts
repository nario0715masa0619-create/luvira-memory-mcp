import { describe, expect, it } from "vitest";
import { loadAuthRegistry, toRequestContext, TokenAuthRegistry } from "../src/auth-registry.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  mem0: { baseUrl: new URL("http://localhost:8888"), apiKey: "mem0-secret", timeoutMs: 1000 },
  scope: { tenant: "personal", project: "shared", subject: "owner" },
  server: {
    host: "127.0.0.1",
    port: 8765,
    apiKey: "gateway-secret",
    allowedOrigins: new Set(),
  },
  governance: { auditPath: "unused-in-this-test.jsonl" },
  authRegistry: { path: "config/auth-registry.json", required: false },
};

function fileNotFound(): never {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

describe("loadAuthRegistry", () => {
  it("falls back to one implicit read_write entry from the single-token config when no file exists", () => {
    const entries = loadAuthRegistry(config, fileNotFound);
    expect(entries).toEqual([
      { token: "gateway-secret", tenant: "personal", project: "shared", subject: "owner", role: "read_write" },
    ]);
  });

  it("loads multiple entries from a valid registry file", () => {
    const fileContents = JSON.stringify([
      { token: "token-a", tenant: "personal", project: "shared", subject: "owner", role: "read_write" },
      { token: "token-b", tenant: "personal", project: "shared", subject: "owner", role: "read_only" },
    ]);
    const entries = loadAuthRegistry(config, () => fileContents);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ token: "token-b", role: "read_only" });
  });

  it("rejects a registry file with an invalid role", () => {
    const fileContents = JSON.stringify([
      { token: "token-a", tenant: "personal", project: "shared", subject: "owner", role: "admin" },
    ]);
    expect(() => loadAuthRegistry(config, () => fileContents)).toThrow();
  });

  it("rejects a registry file with an empty entry list", () => {
    expect(() => loadAuthRegistry(config, () => "[]")).toThrow();
  });

  it("rejects a registry file with a duplicate token across entries", () => {
    const fileContents = JSON.stringify([
      { token: "same-token", tenant: "personal", project: "shared", subject: "owner", role: "read_write" },
      { token: "same-token", tenant: "personal", project: "kimi-project", subject: "owner", role: "read_only" },
    ]);
    expect(() => loadAuthRegistry(config, () => fileContents)).toThrow();
  });

  it("rejects a registry file with an invalid tenant/project/subject character", () => {
    const fileContents = JSON.stringify([
      { token: "token-a", tenant: "personal/../etc", project: "shared", subject: "owner", role: "read_write" },
    ]);
    expect(() => loadAuthRegistry(config, () => fileContents)).toThrow();
  });
});

describe("loadAuthRegistry with authRegistry.required = true (Post-MVP hardening)", () => {
  const requiredConfig: AppConfig = { ...config, authRegistry: { ...config.authRegistry, required: true } };

  it("throws instead of falling back when the registry file is missing", () => {
    expect(() => loadAuthRegistry(requiredConfig, fileNotFound)).toThrow();
  });

  it("does not return the single-token fallback shape when the file is missing", () => {
    try {
      loadAuthRegistry(requiredConfig, fileNotFound);
      expect.unreachable("loadAuthRegistry should have thrown");
    } catch (error) {
      // Never silently returns the legacy read_write fallback entry.
      expect(error).not.toEqual([
        { token: "gateway-secret", tenant: "personal", project: "shared", subject: "owner", role: "read_write" },
      ]);
    }
  });

  it("throws instead of falling back when the registry file is unreadable (not just missing)", () => {
    const unreadable = (): never => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(() => loadAuthRegistry(requiredConfig, unreadable)).toThrow();
  });

  it("does not leak the credential, scope, or file path in the thrown error message", () => {
    try {
      loadAuthRegistry(requiredConfig, fileNotFound);
      expect.unreachable("loadAuthRegistry should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("gateway-secret");
      expect(message).not.toContain("personal");
      expect(message).not.toContain("owner");
      expect(message).not.toContain(config.authRegistry.path);
    }
  });

  it("loads normally from a valid registry file", () => {
    const fileContents = JSON.stringify([
      { token: "token-a", tenant: "personal", project: "shared", subject: "owner", role: "read_write" },
    ]);
    const entries = loadAuthRegistry(requiredConfig, () => fileContents);
    expect(entries).toEqual([
      { token: "token-a", tenant: "personal", project: "shared", subject: "owner", role: "read_write" },
    ]);
  });

  it("still rejects a malformed registry file even though the file itself was readable", () => {
    const fileContents = JSON.stringify([
      { token: "token-a", tenant: "personal", project: "shared", subject: "owner", role: "admin" },
    ]);
    expect(() => loadAuthRegistry(requiredConfig, () => fileContents)).toThrow();
  });
});

describe("TokenAuthRegistry", () => {
  const entryA = { token: "token-a", tenant: "personal", project: "shared", subject: "owner", role: "read_write" as const };
  const entryB = { token: "token-b", tenant: "personal", project: "kimi-project", subject: "owner", role: "read_only" as const };
  const registry = new TokenAuthRegistry([entryA, entryB]);

  it("resolves the matching entry for a known token", () => {
    expect(registry.resolve("token-a")).toEqual(entryA);
    expect(registry.resolve("token-b")).toEqual(entryB);
  });

  it("returns undefined for an unknown token", () => {
    expect(registry.resolve("token-c")).toBeUndefined();
  });

  it("returns undefined for a token of a different length than any entry", () => {
    expect(registry.resolve("short")).toBeUndefined();
  });

  it("returns undefined for the empty string", () => {
    expect(registry.resolve("")).toBeUndefined();
  });
});

describe("toRequestContext (Phase 3)", () => {
  const entry = { token: "super-secret-token-value", tenant: "personal", project: "shared", subject: "owner", role: "read_only" as const };

  it("carries scope and role unchanged", () => {
    const context = toRequestContext(entry);
    expect(context.scope).toEqual({ tenant: "personal", project: "shared", subject: "owner" });
    expect(context.role).toBe("read_only");
  });

  it("never surfaces the raw token as the credential fingerprint", () => {
    const context = toRequestContext(entry);
    expect(context.credentialFingerprint).not.toBe(entry.token);
    expect(context.credentialFingerprint).not.toContain(entry.token);
  });

  it("derives a deterministic credential fingerprint for the same token", () => {
    expect(toRequestContext(entry).credentialFingerprint).toBe(toRequestContext(entry).credentialFingerprint);
  });

  it("derives a different credential fingerprint for a different token", () => {
    const other = { ...entry, token: "a-completely-different-token-value" };
    expect(toRequestContext(entry).credentialFingerprint).not.toBe(toRequestContext(other).credentialFingerprint);
  });
});
