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

1. MCP client to Gateway: `LUVIRA_MCP_API_KEY`
2. Gateway to Mem0: `MEM0_API_KEY`

## Exposure limitation

`0.0.0.0` is permitted only as the listen address inside the Docker network.
Keep Docker port publishing restricted to Windows loopback at
`127.0.0.1:8765:8765`; do not publish port 8765 to a LAN interface or an
external network. Bare-metal and host execution must continue to use
`127.0.0.1`. Bearer authentication remains mandatory at both loopback and
container boundaries. A future remote deployment requires TLS and
standards-based OAuth authorization in addition to network controls.
