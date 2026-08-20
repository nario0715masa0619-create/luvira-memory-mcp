import { describe, expect, it } from "vitest";
import { scopeFingerprint, scopeToMem0UserId, StaticScopeResolver } from "../src/scope.js";

describe("scopeToMem0UserId", () => {
  it("is deterministic: the same scope always derives the same user_id", () => {
    const scope = { tenant: "personal", project: "shared", subject: "owner" };
    expect(scopeToMem0UserId(scope)).toBe(scopeToMem0UserId({ ...scope }));
  });

  it("derives a different user_id when only project differs", () => {
    const base = { tenant: "personal", project: "project-a", subject: "owner" };
    const other = { ...base, project: "project-b" };
    expect(scopeToMem0UserId(base)).not.toBe(scopeToMem0UserId(other));
  });

  it("derives a different user_id when only tenant differs", () => {
    const base = { tenant: "tenant-a", project: "shared", subject: "owner" };
    const other = { ...base, tenant: "tenant-b" };
    expect(scopeToMem0UserId(base)).not.toBe(scopeToMem0UserId(other));
  });

  it("derives a different user_id when only subject differs", () => {
    const base = { tenant: "personal", project: "shared", subject: "user-1" };
    const other = { ...base, subject: "user-2" };
    expect(scopeToMem0UserId(base)).not.toBe(scopeToMem0UserId(other));
  });
});

describe("StaticScopeResolver as a per-request resolver", () => {
  it("resolves to exactly the scope it was constructed with, regardless of how many times it is called", async () => {
    const scope = { tenant: "test", project: "project-a", subject: "user-1" };
    const resolver = new StaticScopeResolver(scope);
    expect(await resolver.resolve()).toEqual(scope);
    expect(await resolver.resolve()).toEqual(scope);
  });

  it("two independently constructed resolvers for different scopes never share state", async () => {
    const resolverA = new StaticScopeResolver({ tenant: "test", project: "project-a", subject: "user-1" });
    const resolverB = new StaticScopeResolver({ tenant: "test", project: "project-b", subject: "user-1" });
    expect(scopeToMem0UserId(await resolverA.resolve())).not.toBe(scopeToMem0UserId(await resolverB.resolve()));
  });
});

describe("scopeFingerprint", () => {
  it("is deterministic and never returns the raw user_id", () => {
    const userId = scopeToMem0UserId({ tenant: "personal", project: "shared", subject: "owner" });
    const fingerprint = scopeFingerprint(userId);
    expect(fingerprint).toBe(scopeFingerprint(userId));
    expect(fingerprint).not.toContain(userId);
  });

  it("differs for different resolved scopes, giving audit logs per-project resolution", () => {
    const userIdA = scopeToMem0UserId({ tenant: "test", project: "project-a", subject: "user-1" });
    const userIdB = scopeToMem0UserId({ tenant: "test", project: "project-b", subject: "user-1" });
    expect(scopeFingerprint(userIdA)).not.toBe(scopeFingerprint(userIdB));
  });
});
