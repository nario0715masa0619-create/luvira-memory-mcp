import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { MemoryScope } from "./scope.js";
import { scopeFingerprint, scopePart } from "./scope.js";

/**
 * Project-Aware Scope (Phase 1): a client's role determines whether write
 * tools (memory_add/update/delete) may run at all. Phase 1 only loads and
 * validates this field — no code path enforces it yet (see tools.ts /
 * memory-service.ts). Enforcement is Phase 3.
 */
export type ClientRole = "read_only" | "read_write";

/**
 * One row of the auth registry: a Gateway Bearer token mapped to the scope
 * and role it authenticates as. `token` is the full secret value, never a
 * hash — the registry file is exactly as sensitive as `.env` and must stay
 * git-ignored.
 *
 * Phase 1 only uses `token` (to answer "is this caller authorized at all").
 * `tenant`/`project`/`subject`/`role` are validated and carried here so
 * Phase 2 (dynamic ScopeResolver) and Phase 3 (role enforcement) have
 * something to consume without a second migration of this file's shape.
 */
export interface AuthRegistryEntry {
  readonly token: string;
  readonly tenant: string;
  readonly project: string;
  readonly subject: string;
  readonly role: ClientRole;
}

const authRegistryEntrySchema = z.object({
  token: z.string().trim().min(1),
  tenant: scopePart,
  project: scopePart,
  subject: scopePart,
  role: z.enum(["read_only", "read_write"]),
});

// A duplicate token would make TokenAuthRegistry.resolve() silently pick
// whichever entry's role/scope happens to appear first, hiding a real
// provisioning mistake behind unpredictable behavior. Fail closed at load
// time instead of at request time.
const authRegistryFileSchema = z.array(authRegistryEntrySchema).min(1).refine(
  (entries) => new Set(entries.map((entry) => entry.token)).size === entries.length,
  { message: "Auth registry contains a duplicate token" },
);

/**
 * Loads the multi-token auth registry described in the Project-Aware Scope
 * design review (Phase 1). If `config.authRegistry.path` names an existing
 * file, its entries are the entire registry. Otherwise, when
 * `config.authRegistry.required` is `false` (the default), the Gateway
 * falls back to exactly one implicit entry built from the pre-existing
 * single-token configuration (`LUVIRA_MCP_API_KEY` / `LUVIRA_SCOPE_*`) with
 * `role: "read_write"` — this is what keeps every current single-token
 * deployment behaviorally unchanged without requiring a new file to exist.
 *
 * Post-MVP hardening: when `config.authRegistry.required` is `true`, a
 * missing/unreadable registry file throws instead of falling back, failing
 * the Gateway's startup closed rather than silently reverting every caller
 * to one shared read_write credential. This only changes what happens when
 * the file cannot be *read* — a file that exists but is malformed (bad
 * JSON, a schema violation, a duplicate token) already fails closed below
 * regardless of this flag, and that is unchanged.
 */
export function loadAuthRegistry(
  config: AppConfig,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AuthRegistryEntry[] {
  let raw: string;
  try {
    raw = readFile(config.authRegistry.path);
  } catch {
    if (config.authRegistry.required) {
      // Generic and deliberately silent on specifics: no path, token,
      // scope, or credential value — matches the rest of this module's
      // error surface (see GatewayError usage elsewhere in the Gateway).
      throw new Error("Auth registry is required but unavailable.");
    }
    return [
      {
        token: config.server.apiKey,
        tenant: config.scope.tenant,
        project: config.scope.project,
        subject: config.scope.subject,
        role: "read_write",
      },
    ];
  }

  const parsed: unknown = JSON.parse(raw);
  return authRegistryFileSchema.parse(parsed);
}

/**
 * Resolves a caller-presented Bearer token against the registry. Compares
 * every entry with `timingSafeEqual` (equal-length values only, same as the
 * pre-registry single-token check in http-server.ts) rather than a plain
 * `===`, so a mismatched-length guess is not distinguishable in timing from
 * a same-length wrong guess for any one entry.
 */
export class TokenAuthRegistry {
  constructor(private readonly entries: readonly AuthRegistryEntry[]) {}

  resolve(presentedToken: string): AuthRegistryEntry | undefined {
    const presented = Buffer.from(presentedToken);
    for (const entry of this.entries) {
      const candidate = Buffer.from(entry.token);
      if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) {
        return entry;
      }
    }
    return undefined;
  }
}

/**
 * Project-Aware Scope (Phase 2/3): what a resolved `AuthRegistryEntry`
 * contributes to request handling once authentication has already
 * succeeded. Deliberately narrower than `AuthRegistryEntry` — `token` never
 * appears here, so nothing downstream of `toRequestContext` can log,
 * serialize, or otherwise leak the raw credential. `role` is now enforced
 * by `MemoryService` (Phase 3); `credentialFingerprint` exists so an audit
 * event can identify which credential acted without ever holding the token.
 */
export interface AuthenticatedRequestContext {
  readonly scope: MemoryScope;
  readonly role: ClientRole;
  readonly credentialFingerprint: string;
}

export function toRequestContext(entry: AuthRegistryEntry): AuthenticatedRequestContext {
  return {
    scope: { tenant: entry.tenant, project: entry.project, subject: entry.subject },
    role: entry.role,
    // Reuses scope.ts's short one-way hash (sha256, truncated) — the same
    // construction as scopeFingerprint, applied to a credential instead of
    // a scope string. Not a rename to a credential-specific name: the
    // operation ("deterministic, non-reversible, short") is identical.
    credentialFingerprint: scopeFingerprint(entry.token),
  };
}
