# Client configuration

All clients point to the same Streamable HTTP endpoint. Each client should use its own dedicated Bearer credential, registered in the Auth Registry (`config/auth-registry.json`) with its own `role` (`read_write` or `read_only`) — see `docs/security.md`. The Gateway core does not receive or use client product names; a client's scope and role come solely from which registered token it presents, never from anything the client identifies itself as. A single shared `LUVIRA_MCP_API_KEY` remains supported as the fallback when no registry file exists, but is not the production-recommended setup once more than one client is in use.

## LibreChat

For the current Docker-based LibreChat setup:

```yaml
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

Set `LUVIRA_MCP_API_KEY` in LibreChat's untracked environment configuration, then restart or reinitialize the MCP server. Do not put the value directly in `librechat.yaml`.

Docker Desktop on this machine was verified to forward `host.docker.internal:8765` to the Gateway even though the Gateway binds to Windows host loopback. If that behavior changes after a Docker Desktop upgrade, repeat an MCP initialize reachability check; do not weaken the Gateway bind silently.

For LibreChat running directly on the Windows host, use `http://127.0.0.1:8765/mcp` and allow `127.0.0.1:8765` instead.

## Codex

Set the Gateway token in the environment that launches Codex:

```powershell
$env:LUVIRA_MCP_API_KEY='<Gateway key>'
```

Then add this to user-level `~/.codex/config.toml` or a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.luvira_memory]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "LUVIRA_MCP_API_KEY"
required = true
startup_timeout_sec = 10
tool_timeout_sec = 60
default_tools_approval_mode = "writes"
```

Restart the Codex host, then use `/mcp` or the MCP settings UI to confirm the five tools. Codex CLI and Codex IDE/desktop clients on the same host share `config.toml` configuration.

## Other clients

Configure a Streamable HTTP server with:

- URL: `http://127.0.0.1:8765/mcp`
- Header: `Authorization: Bearer <LUVIRA_MCP_API_KEY>`

Prefer an environment-variable or secret-store reference supported by that client. Static secrets in committed client configuration are not acceptable.
