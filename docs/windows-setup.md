# Windows deployment and recovery

This is the end-to-end rebuild guide for the local shared-memory stack. The
canonical operational path runs Mem0, Luvira Memory MCP, and LibreChat with
Docker Compose. No repository requires a particular commit beyond having the
Compose files and configuration fields described here.

## Required repositories

Clone or check out the three repositories as siblings under the current
user's Documents directory:

```text
<Documents>\
  luvira-memory-mcp\
  mem0\
    server\
  LibreChat\
```

The bootstrap derives these paths from its own location. Non-standard layouts
can use its `-McpPath`, `-Mem0Path`, and `-LibreChatPath` overrides.

## Prerequisites

- Windows 11 and PowerShell 5.1 or newer
- Docker Desktop with **Start Docker Desktop when you sign in** enabled
- Node.js 20.6 or newer for development, tests, and local builds
- an OpenRouter account and API key
- the self-hosted Mem0 repository and its model-provider credentials

Docker Desktop startup is separate from the scheduled task. The task waits for
the Docker engine; it does not launch Docker Desktop.

## Secrets

Never commit a populated `.env`, `librechat.yaml`, or
`docker-compose.override.yml`. Copy supplied example files where available,
then edit only the ignored local copies.

Luvira Memory MCP:

```powershell
Set-Location <Documents>\luvira-memory-mcp
Copy-Item .env.example .env
```

Set `MEM0_API_KEY`, a separate `LUVIRA_MCP_API_KEY`, the three
`LUVIRA_SCOPE_*` values, and any required allowed origins. Keep
`MEM0_BASE_URL`, timeouts, host, and port at their documented defaults unless
the deployment differs.

Mem0 uses `mem0/server/.env`. Prepare it from the repository's example and set
the model and embedding provider variables required by that checkout, plus its
PostgreSQL connection variables, `POSTGRES_PASSWORD`, `JWT_SECRET`, and the API
authentication settings used to issue `MEM0_API_KEY`. Variables vary by Mem0
version; use the checked-out server example as the authority.

LibreChat uses ignored local files. Set `OPENROUTER_KEY` and the same
`LUVIRA_MCP_API_KEY` used by MCP client authentication in `LibreChat/.env`.
Never paste either value directly into `librechat.yaml`.

## Mem0

```powershell
Set-Location <Documents>\mem0\server
docker compose up -d --wait
Invoke-WebRequest http://127.0.0.1:8888/openapi.json -UseBasicParsing
```

The OpenAPI request must return HTTP 200. PostgreSQL, Mem0, and the dashboard
should report healthy in `docker compose ps`.

## Luvira Memory MCP

Docker Compose is the canonical operational path:

```powershell
Set-Location <Documents>\luvira-memory-mcp
docker compose up -d --wait
Invoke-WebRequest http://127.0.0.1:8765/health/live -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:8765/health/ready -UseBasicParsing
```

Both health endpoints must return HTTP 200. The container listens on
`0.0.0.0:8765`, while Compose publishes only `127.0.0.1:8765` on Windows.

## LibreChat

Configure the ignored `LibreChat/librechat.yaml` with the OpenRouter endpoint
used by the checkout and these settings. Preserve other required LibreChat
configuration already present in the local file.

```yaml
endpoints:
  custom:
    - name: OpenRouter
      apiKey: '${OPENROUTER_KEY}'
      baseURL: 'https://openrouter.ai/api/v1'
      addParams:
        maxTokens: 4096
      customParams:
        defaultParamsEndpoint: openAI
        paramDefinitions:
          - key: max_tokens
            default: 4096

mcpSettings:
  allowedAddresses:
    - 'host.docker.internal:8765'

mcpServers:
  luvira-memory:
    type: streamable-http
    url: http://host.docker.internal:8765/mcp
    headers:
      Authorization: 'Bearer ${LUVIRA_MCP_API_KEY}'
    timeout: 60000
    serverInstructions: true
    requiresOAuth: false
```

Use `addParams.maxTokens`, not `addParams.max_tokens`: LibreChat's custom
endpoint configuration property is camelCase and maps it to the provider's
`max_tokens` request field. Using `max_tokens` in `addParams` can leave the
effective limit unchanged and OpenRouter may reject an oversized request with
HTTP 402. `customParams.paramDefinitions` exposes the provider-form field to
the UI with a 4096 default.

Start the main services:

```powershell
Set-Location <Documents>\LibreChat
docker compose up -d api mongodb meilisearch vectordb rag_api
Invoke-WebRequest http://127.0.0.1:3080/readyz -UseBasicParsing
```

The response must be HTTP 200 with `OK`. `admin-panel` is not part of normal
bootstrap because it is an optional administration surface, not a dependency
of chat or shared Memory.

## Windows autostart

After Docker Desktop login startup is enabled, register the current checkout:

```powershell
Set-Location <Documents>\luvira-memory-mcp
.\scripts\windows\register-bootstrap-task.ps1 -WhatIf
.\scripts\windows\register-bootstrap-task.ps1
Get-ScheduledTaskInfo -TaskName 'Luvira Memory Bootstrap'
```

The task is named `Luvira Memory Bootstrap`. It runs once at current-user
logon, waits for each dependency, and exits after readiness succeeds. Review
`logs/bootstrap.log` and `logs/bootstrap.previous.log` for structured results.

Remove it without stopping containers or deleting data:

```powershell
.\scripts\windows\register-bootstrap-task.ps1 -Unregister
```

## Codex CLI

Codex uses the native Streamable HTTP MCP configuration for `luvira_memory`.
Keep `LUVIRA_MCP_API_KEY` in this repository's ignored `.env`, and launch Codex
through the Windows launcher instead of invoking `codex` directly:

```powershell
.\scripts\windows\start-codex.ps1
```

Normal Codex arguments are forwarded, for example
`.\scripts\windows\start-codex.ps1 mcp list`. The launcher reads only
`LUVIRA_MCP_API_KEY`, adds it to the child process environment, and removes it
from the launcher environment after Codex exits. It does not persist User or
Machine environment variables and does not put the credential in Codex
arguments or `config.toml`.

## Memory E2E verification

After `/readyz` succeeds, initialize `luvira-memory` from LibreChat and confirm
that five tools are listed. Run only `memory_search` or `memory_get` against a
known existing record. A rebuild check must not call add, update, or delete and
must not print Memory text to logs.

## Recovery and troubleshooting

- **Docker Desktop does not start:** enable login startup in Docker Desktop,
  start it manually, and verify `docker info` before rerunning bootstrap.
- **Mem0 unavailable:** check `docker compose ps` and container logs under
  `mem0/server`; verify its `.env`, PostgreSQL health, and
  `http://127.0.0.1:8888/openapi.json`.
- **MCP unavailable:** verify Mem0 first, then MCP container health,
  `127.0.0.1:8765` publishing, `/health/ready`, and matching gateway keys.
- **LibreChat `/readyz` returns 503:** inspect the `api` container and its
  MongoDB, Meilisearch, vector DB, and RAG dependencies; then recheck ignored
  local configuration.
- **OpenRouter HTTP 402 mentioning `max_tokens`:** use
  `addParams.maxTokens: 4096`, restart LibreChat, and verify effective custom
  endpoint parameters.
- **MCP shows zero tools or `OAuth Required: true`:** confirm
  `type: streamable-http`, `requiresOAuth: false`, the allowed address, URL,
  Bearer environment reference, and that LibreChat received
  `LUVIRA_MCP_API_KEY`; restart or reinitialize the MCP connection.
