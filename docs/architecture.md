# Architecture

## Boundaries

```text
┌──────────────────────────────────────────────────────────────┐
│ MCP clients                                                  │
│ Any standards-compatible client; no client-specific core     │
└───────────────────────────────┬──────────────────────────────┘
                                │ MCP Streamable HTTP
┌───────────────────────────────▼──────────────────────────────┐
│ Luvira Memory MCP                                            │
│ HTTP security → MCP tools → MemoryService → ScopeResolver    │
│                                      │                       │
│                             Mem0Client (REST only)            │
└───────────────────────────────┬──────────────────────────────┘
                                │ X-API-Key
┌───────────────────────────────▼──────────────────────────────┐
│ Self-hosted Mem0                                             │
│ Canonical memory store → PostgreSQL / pgvector               │
└──────────────────────────────────────────────────────────────┘
```

The Gateway persists nothing. A process restart loses no memory state because Mem0 remains the source of memory.

## ScopeResolver

`ScopeResolver` is the trust boundary between connection/authentication policy and memory operations. `StaticScopeResolver` produces:

```text
luvira:v1:<tenant>:<project>:<subject>
```

Each component is validated and URI encoded. This value becomes the Mem0 `user_id`; it is never accepted from tool arguments.

`StaticScopeResolver` is constructed fresh per HTTP request (see `http-server.ts`), seeded from the `tenant`/`project`/`subject` of the Auth Registry entry the presented Bearer token resolved to — not from a single process-wide value. Two requests presenting different tokens resolve to different Mem0 `user_id`s on the same running Gateway process; a request with no matching registry entry never reaches `MemoryService` at all (401 first). The single-token fallback (`LUVIRA_MCP_API_KEY` / `LUVIRA_SCOPE_*`) is what the Gateway uses when no registry file is present — see `docs/security.md`. Untrusted model arguments and arbitrary client headers must not directly become a scope.

## Ownership enforcement

- Add: inject resolved `user_id`.
- Search: construct `filters` internally with only the resolved `user_id`.
- Get: fetch, require a top-level `user_id`, compare with the resolved scope.
- Update/delete: perform the same owned get before mutation.
- Mismatch: return `not_found`, never a distinguishable forbidden response.
- Missing `user_id` in a Mem0 response: fail closed with `upstream_contract_error`.

The preflight check prevents normal cross-scope access. If stronger atomic multi-tenant isolation is needed in a hostile concurrent environment, Mem0 itself must provide scoped mutation primitives; the Gateway does not invent a second canonical store to emulate them.

## Mem0 contract

Only routes confirmed in the local FastAPI implementation and OpenAPI document are used:

| Tool | Route |
|---|---|
| `memory_add` | `POST /memories` |
| `memory_search` | `POST /search` |
| `memory_get` | `GET /memories/{memory_id}` |
| `memory_update` | `PUT /memories/{memory_id}` |
| `memory_delete` | `DELETE /memories/{memory_id}` |

The local OpenAPI does not specify concrete success response schemas for these operations. Therefore responses stay `unknown` at the REST boundary and are passed through as `structuredContent.data`; the Gateway validates only the fields required for a security decision.

## Errors

Tool validation and execution failures return MCP Tool Execution Errors (`isError: true`) with a normalized code, safe message, and retryable flag. Malformed MCP protocol messages remain protocol errors handled by the official SDK.
