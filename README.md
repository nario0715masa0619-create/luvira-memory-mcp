# Luvira Memory MCP

Luvira Memory MCP is a thin, client-agnostic MCP Gateway for a self-hosted Mem0 server. It exposes five memory tools over stateless Streamable HTTP while keeping Mem0 as the only canonical memory store.

**Status: Memory Multi-Client / Multi-Project Governance MVP — COMPLETE.** Dedicated per-client credentials, per-request project isolation, and Gateway-side read/write role enforcement are implemented and verified. See [MVP completion record](docs/MVP_COMPLETION.md) for the full baseline.

```text
MCP clients ── Streamable HTTP ── Luvira Memory MCP ── REST ── Self-hosted Mem0
                                                                  │
                                                                  └── PostgreSQL / pgvector
```

The Gateway has no database, memory cache, or memory index. Its core does not identify or branch on LibreChat, Codex, Claude Code, Cursor, or any other client.

## Authority rule

Memory is supplemental, non-authoritative context. It must not override Git, an Approved Specification, Canonical Project Documentation, or another canonical source. If Memory conflicts with a canonical source, prefer the canonical source.

This rule is included in MCP server instructions, every tool description, and structured tool results (`authority: "supplemental"`).

## Requirements

- Node.js 20.6 or newer
- Running self-hosted Mem0 REST API
- A Mem0 per-user API key

## Setup

```powershell
Copy-Item .env.example .env
npm install --ignore-scripts
```

Edit the untracked `.env` and set at least:

```dotenv
MEM0_API_KEY=<issued Mem0 API key>
LUVIRA_MCP_API_KEY=<a separate long random Gateway key>
LUVIRA_SCOPE_TENANT=personal
LUVIRA_SCOPE_PROJECT=shared
LUVIRA_SCOPE_SUBJECT=owner
```

Do not reuse the Mem0 key as the Gateway key. Do not commit `.env`; it is ignored by Git.

## Run

Development:

```powershell
npm run dev
```

Compiled:

```powershell
npm run build
npm start
```

The endpoint is `http://127.0.0.1:8765/mcp` by default. The server defaults to a loopback bind; the wildcard bind is available for the Docker container, whose published port remains restricted to Windows loopback. Every MCP request requires `Authorization: Bearer <LUVIRA_MCP_API_KEY>`. Requests with an `Origin` header are accepted only when the exact origin is listed in `LUVIRA_ALLOWED_ORIGINS`.

Docker Compose:

```powershell
docker compose up -d --build
```

Compose injects the existing untracked `.env`, connects to Mem0 through
`http://host.docker.internal:8888`, and publishes the Gateway only on
`127.0.0.1:8765`. `/health/live` checks the Gateway process without contacting
Mem0. `/health/ready` additionally checks authenticated, read-only Mem0 access.

## Tools

- `memory_add`
- `memory_search`
- `memory_get`
- `memory_update`
- `memory_delete`

No tool accepts `user_id`. The Gateway resolves its trusted scope and injects Mem0 `user_id` itself. `memory_search` always supplies exactly that `filters.user_id`. Get, update, and delete first retrieve the Memory and verify its `user_id`; foreign-scope objects are reported as `not_found`.

`memory_add` passes Mem0's real `messages`, `metadata`, `expiration_date`, `infer`, and `memory_type` fields. With inference enabled, Mem0 may merge, update, or remove existing memories rather than always creating one new record.

## Tests

```powershell
npm test
npm run check
npm run build
```

The live integration test is opt-in and creates a unique `integration-test` scope. It only updates or deletes IDs returned by its own add call:

```powershell
$env:RUN_MEM0_INTEGRATION='1'
$env:MEM0_API_KEY='<issued test-capable Mem0 API key>'
$env:MEM0_BASE_URL='http://127.0.0.1:8888'
npm test -- test/integration/mem0.integration.test.ts
```

For a complete three-repository Windows rebuild, follow the
[Windows deployment and recovery guide](docs/windows-setup.md). See also
[architecture](docs/architecture.md), [security](docs/security.md),
[client configuration](docs/client-configuration.md),
[automatic startup](docs/windows-autostart.md), and the
[MVP completion record](docs/MVP_COMPLETION.md).
