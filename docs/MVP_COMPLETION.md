# Luvira Memory MVP Completion

## Status

COMPLETE

## Completion Date

2026-08-21

## Baseline Commit

`0f0fc523e1c489dd5002104a2dff773b65a8633a`

## What Is Complete

- **Memory backend**: self-hosted Mem0 (PostgreSQL / pgvector, Dashboard) fronted by the Luvira Memory MCP Gateway. The Gateway persists nothing itself; Mem0 remains the only canonical memory store.
- **Five MCP tools**: `memory_add`, `memory_search`, `memory_get`, `memory_update`, `memory_delete`, exposed identically to every client over stateless Streamable HTTP. No tool accepts `user_id`, `tenant`, `project`, or `subject` as an input — scope is always Gateway-resolved.
- **Multi-project isolation**: a presented Bearer token resolves (via the Auth Registry) to a `tenant`/`project`/`subject` triple, which deterministically derives the Mem0 `user_id` for that request. Two tokens registered under different projects are fully isolated from each other on the same running Gateway process.
- **Multi-client dedicated credentials**: Claude Code, Codex, LibreChat, and Kimi each authenticate with their own Bearer token rather than one shared secret. Each client's normal launch path (headersHelper / launcher script / `librechat.yaml`) resolves its own credential by default — none silently fall back to another client's credential.
- **Gateway-side write role enforcement**: each Auth Registry entry carries a `role` (`read_only` or `read_write`). A `read_only` credential's `memory_add`/`memory_update`/`memory_delete` calls are blocked at the Gateway — before any Mem0 call — independent of what any client-side tool restriction does or doesn't do. Read tools (`memory_search`/`memory_get`) are never role-gated.
- **Production fail-closed hardening**: `LUVIRA_AUTH_REGISTRY_REQUIRED=true` makes a missing/unreadable Auth Registry file fail Gateway startup instead of silently falling back to the single shared-token behavior. This machine currently runs with this flag active.

## Security Guarantees

- **Memory Authority is fixed at SUPPLEMENTAL.** No classification, role, or credential promotes a Memory record to Canonical Authority. Git, an Approved Specification, and Canonical Project Documentation always take precedence over Memory when they conflict. This is stated in MCP server instructions, every tool description, and every structured tool result.
- **Ownership / cross-scope concealment**: `memory_get`/`memory_update`/`memory_delete` verify the target Memory's `user_id` against the caller's resolved scope before acting. A foreign-scope Memory is reported as `not_found` — indistinguishable from a Memory that never existed. Cross-project `update`/`delete` attempts reach zero Mem0 mutation calls.
- **Role and scope come only from the Auth Registry token entry the caller presents** — never from a client-declared name, a request field, or `source_client`/`source_project` (both remain provenance-only, never authorization inputs). No Core code branches on which client is calling.
- **Write governance** (unchanged by role enforcement, still fully in effect for `read_write` credentials): classification/provenance tracking, high-confidence secret-pattern detection, Automation Policy (explicit-request requirements for decision-like classifications), an unconditional block on `infer=true`, and audit-before-mutation with fail-closed behavior if the audit sink itself is unavailable.
- **Fail-closed by default at every layer that matters**: a malformed Auth Registry file always fails Gateway startup regardless of any setting; an unknown Bearer token is always 401; a role-blocked write always makes zero Mem0 calls.

## Client Matrix

| Client | Dedicated Credential | Gateway Role | Default Launch Path |
|---|---|---|---|
| Claude Code | Yes | `read_write` | `~/.claude.json` headersHelper → `.env.claude` (default, no argument needed) |
| Codex | Yes | `read_write` | `start-codex.ps1` → `.env.codex` (default, no argument needed) |
| LibreChat | Yes | `read_write` | `librechat.yaml` → `LUVIRA_MCP_LIBRECHAT_API_KEY` |
| Kimi Code CLI | Yes | `read_only` | `start-kimi.ps1` → `.env.kimi` (default, no argument needed) |

All four credentials were verified to have distinct, unique credential fingerprints (a one-way hash, never the raw token) in the governance audit log.

## Kimi Safety (three-layer defense)

1. **Tool discovery**: Kimi's `mcp.json` only lists `memory_search`/`memory_get` in `enabledTools` — write tools are never presented to the model.
2. **Client-side deny rules**: `config.toml` explicitly denies `memory_add`/`memory_update`/`memory_delete`.
3. **Gateway-side role enforcement**: even bypassing (1) and (2) entirely and calling the Gateway directly with Kimi's own credential, a write attempt is blocked with `role_forbidden_write` before any Mem0 call — verified live.

## Project Isolation

Verified live with two synthetic, distinct projects sharing one running Gateway process:

- `memory_add` for project A and project B each resolve to their own, different Mem0 `user_id`.
- `memory_search` results never mix across projects.
- Cross-project `memory_get` → `not_found`.
- Cross-project `memory_update` → `not_found`, zero Mem0 `PUT` calls.
- Cross-project `memory_delete` → `not_found`, zero Mem0 `DELETE` calls.
- The single-token fallback scope (used when no registry file is present) resolves to exactly the legacy `LUVIRA_SCOPE_*` values, unchanged.

## Governance

- **Classification / provenance**: `classification`, `source_type`, `source_project`, `source_client`, `explicit_user_request` are all client-asserted, never verified fact, and never used for authorization or scope resolution.
- **Secret detection**: high-confidence secret-pattern matches in write content unconditionally block the write, before it reaches Mem0.
- **Automation Policy**: classifications representing a human-standing decision (e.g. `USER_DECISION`, `ORGANIZATION_POLICY`, `PROJECT_DECISION`) require `explicit_user_request: true`; an UPDATE cannot downgrade a protected existing record's classification to bypass this.
- **`infer=true` is unconditionally blocked** on `memory_add` — Mem0's opaque server-side merge/update/remove cannot be audited before it happens.
- **DELETE protection**: deleting a Memory whose stored classification represents a human-standing decision requires `explicit_user_request: true`.

## Audit

Every write-governance decision (ALLOW and BLOCK) is recorded before any Mem0 mutation, and the audit write itself fails closed (no Mem0 call) if the sink is unavailable. Each event records:

- `decision`, `reasonCodes`
- `role` (the authenticated credential's role)
- `credentialFingerprint` (one-way hash of the Bearer token — verified unique per client, never the raw value)
- `scopeFingerprint` (one-way hash of the resolved Mem0 `user_id`)
- `classification`, and (on ALLOW only) `contentHash`/`memoryId`

Never recorded: raw Bearer tokens, raw `tenant`/`project`/`subject` values, Memory body text, or raw metadata.

## Production Hardening

- `LUVIRA_AUTH_REGISTRY_REQUIRED=true` is active on this machine's Gateway.
- Verified live: with a valid registry, the Gateway starts healthy and dedicated-credential clients authenticate normally.
- Verified live: with the registry file made unavailable (a safe path-override simulation — the real registry file was never deleted), the Gateway fails to start and enters a crash-loop rather than falling back to the shared-token behavior. The only information logged is a generic `gateway_start_failed` event — no path, token, or scope value.
- Verified live: restoring the valid registry path returns the Gateway to healthy.
- Verified live: the legacy shared token now returns `401 Unauthorized` — it is not a registered Auth Registry entry.
- Zero real credentials, tokens, or `.env` values exist in any Git-tracked file in this repository.

## Verified E2E

| Client | Read | Write |
|---|---|---|
| Claude Code | PASS | PASS (synthetic add → get → delete) |
| Codex | PASS | Gateway-level PASS (direct); a non-interactive `codex exec` write attempt was independently blocked by Codex's own client-side approval gate before ever reaching the Gateway — confirming that layer is intact, not bypassed |
| LibreChat | PASS | Not exercised (read-only verification was sufficient; role is `read_write` by registry configuration) |
| Kimi | PASS | Gateway `role_forbidden_write` BLOCK confirmed; zero Mem0 mutation calls |

All synthetic test records created during verification were deleted; zero orphan records remain in Mem0.

## Known Deferred Items

These do not block MVP completion; each is a distinct, separable future decision:

- Global + project combined reads (a memory scope that spans more than one project)
- Classification-based scope inheritance
- Project rename workflow
- Project retirement workflow
- `REVIEW_REQUIRED` / a human approval UI (no verified approval channel exists yet — see `governance/types.ts`)
- JWT / OAuth authentication
- An external policy engine
- A new database (the Auth Registry remains a flat, git-ignored JSON file; Mem0/PostgreSQL remains the only data store)
- Continuous/ongoing memory governance review process
- Legacy variable cleanup: the retired shared token's value still exists (unused for authorization) in `luvira-memory-mcp/.env` and `LibreChat/.env`'s old `LUVIRA_MCP_API_KEY` lines, pending a separate cleanup decision

## Explicit Non-Goals

The following are deliberately out of scope, not merely deferred:

- Canonical project state management inside this Gateway
- Promoting chat history to a Source of Truth
- Promoting Memory to Canonical Authority under any classification or role
- Client-specific Core branching (no code path may change behavior based on which product is calling)
- Accepting `project`/`tenant`/`subject`/`user_id` from a tool request field
- Using `source_project` or `source_client` as an authorization input

## Operational Notes

- Registry file: `config/auth-registry.json` (git-ignored, mounted read-only into the Docker container).
- Dedicated per-client credential files (`.env.claude`, `.env.codex`, `.env.kimi`) and LibreChat's `LUVIRA_MCP_LIBRECHAT_API_KEY` are all git-ignored; none are tracked in this repository.
- `docker compose restart` does **not** reload `.env` changes for an already-created container — use `docker compose up -d --force-recreate <service>` (or `up -d --build` after a source change) to pick up configuration or code changes.
- See `docs/security.md` for the full Auth Registry / fail-closed mode reference, and `docs/client-configuration.md` for per-client setup.

## Next Changes Require New Decision

Any of the Known Deferred Items above, or any change to the Explicit Non-Goals, requires a new, separate design decision before implementation — none are authorized by this completion record.
