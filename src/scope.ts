import { createHash } from "node:crypto";
import { z } from "zod";

// Exported so other modules validating a tenant/project/subject component
// (e.g. auth-registry.ts) share exactly this rule rather than a parallel copy.
export const scopePart = z.string().trim().min(1).max(128).regex(/^[\p{L}\p{N}._-]+$/u);

export interface MemoryScope {
  tenant: string;
  project: string;
  subject: string;
}

export interface ScopeResolver {
  resolve(): Promise<MemoryScope>;
}

export class StaticScopeResolver implements ScopeResolver {
  private readonly scope: MemoryScope;

  constructor(scope: MemoryScope) {
    this.scope = {
      tenant: scopePart.parse(scope.tenant),
      project: scopePart.parse(scope.project),
      subject: scopePart.parse(scope.subject),
    };
  }

  async resolve(): Promise<MemoryScope> {
    return { ...this.scope };
  }
}

function encodePart(value: string): string {
  return encodeURIComponent(scopePart.parse(value));
}

export function scopeToMem0UserId(scope: MemoryScope): string {
  return `luvira:v1:${encodePart(scope.tenant)}:${encodePart(scope.project)}:${encodePart(scope.subject)}`;
}

export function scopeFingerprint(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}
