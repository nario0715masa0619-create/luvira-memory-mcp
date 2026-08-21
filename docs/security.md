# Security model

## Controls

- Bare-metal and host execution uses the default `127.0.0.1` bind.
- The Docker container listens on `0.0.0.0:8765` so Docker can forward the
  service, but Compose publishes it only as `127.0.0.1:8765:8765` on Windows.
- Gateway Bearer authentication is mandatory.
- Incoming `Origin`, when present, must exactly match `LUVIRA_ALLOWED_ORIGINS`.
- Bearer comparison uses constant-time comparison for equal-length values.
- HTTP request bodies are limited to 1 MiB.
- Mem0 credentials are sent only as `X-API-Key` on the Gateway-to-Mem0 leg.
- `user_id` is absent from all MCP input schemas.
- Search scope is force-injected; mutation ownership is checked before execution.
- Foreign-scope Memory is indistinguishable from a missing Memory.
- Reserved metadata keys `user_id`, `agent_id`, and `run_id` are rejected.
- Standard logs contain event, request ID, method, status, duration, and optional scope fingerprint—not authorization headers, API keys, request bodies, response bodies, or Memory text.
- Upstream response bodies are not copied into error messages.

## Secrets

`.env` and `.env.*` are ignored, except the value-free `.env.example`. Production deployments should inject secrets through the process environment or an operating-system secret manager.

Use separate credentials for the two trust boundaries:

1. MCP client to Gateway: `LUVIRA_MCP_API_KEY` (or a per-entry token in the auth registry, below)
2. Gateway to Mem0: `MEM0_API_KEY`

## Auth registry (project-aware scope)

By default the Gateway accepts exactly one Bearer token (`LUVIRA_MCP_API_KEY`), mapped to the one scope in `LUVIRA_SCOPE_*`. This is unchanged from every prior release.

Optionally, `LUVIRA_AUTH_REGISTRY_PATH` (default `config/auth-registry.json`) can name a git-ignored JSON file — copy `config/auth-registry.example.json` to start one — listing multiple `{ token, tenant, project, subject, role }` rows. Each row is a separate Bearer token a client can present. When this file exists, it replaces the single-token fallback entirely; when it does not, `LUVIRA_AUTH_REGISTRY_REQUIRED` (below) decides what happens.

Each entry's `tenant`/`project`/`subject` resolve that request's own Mem0 scope (dynamic, per request — not the process-wide `LUVIRA_SCOPE_*`), and `role` (`read_only` / `read_write`) is enforced at the Gateway: a `read_only` credential's `memory_add`/`memory_update`/`memory_delete` calls are blocked before any Mem0 call, independent of what any client-side tool restriction does or doesn't do.

The registry file is exactly as sensitive as `.env` — every row's `token` is a full secret value, never a hash. Keep it out of Git (already covered by `.gitignore`) and out of Docker Compose's build context (mounted read-only as a bind mount instead, same pattern as `logs/`).

### Fail-closed mode (`LUVIRA_AUTH_REGISTRY_REQUIRED`)

By default (`false`), a missing or unreadable registry file makes the Gateway silently fall back to the single-token behavior above — this exists purely so an existing single-token deployment is never broken by this feature's addition. A registry file that exists but is malformed (invalid JSON, a schema violation, a duplicate token) always fails Gateway startup closed, regardless of this setting — that safety property does not depend on `LUVIRA_AUTH_REGISTRY_REQUIRED`.

Set `LUVIRA_AUTH_REGISTRY_REQUIRED=true` once you are relying on a real multi-token registry in a given deployment: a missing/unreadable file then fails Gateway startup instead of falling back, so an accidentally-deleted or not-yet-mounted registry can never silently revert every client to one shared `read_write` credential. The startup failure message is generic — it never includes the file path, a token, or a scope value.

## Exposure limitation

`0.0.0.0` is permitted only as the listen address inside the Docker network.
Keep Docker port publishing restricted to Windows loopback at
`127.0.0.1:8765:8765`; do not publish port 8765 to a LAN interface or an
external network. Bare-metal and host execution must continue to use
`127.0.0.1`. Bearer authentication remains mandatory at both loopback and
container boundaries. A future remote deployment requires TLS and
standards-based OAuth authorization in addition to network controls.
