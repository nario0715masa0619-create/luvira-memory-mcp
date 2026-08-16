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

## Claude Code Desktop

Claude Code Desktop uses its native Streamable HTTP MCP client with a
user-scope server entry. これは全ローカルプロジェクトで共有される設定であり、
プロジェクトごとの `.mcp.json` とは別経路である。

### アーキテクチャ

```text
Claude Code Desktop / Local session
  -> ~/.claude.json (user-scope MCP設定)
  -> headersHelper (scripts/windows/get-luvira-mcp-headers.ps1)
  -> 無視される luvira-memory-mcp/.env
  -> Authorization: Bearer <実行時に読み込んだ値>
  -> http://127.0.0.1:8765/mcp
  -> Luvira Memory MCP
  -> Self-hosted Mem0
```

`headersHelper` は Claude Code が MCP 接続を確立する都度起動される子プロセスで、
標準出力に 1 行の `Authorization` JSON だけを返す。資格情報はプロセス環境変数にも
リポジトリにも残らない。

### 設定

user-scope の MCP 設定を使用すること。`~/.claude.json` のトップレベル
`mcpServers` に次の形で登録する(値は構造の例であり、資格情報の実値はここにも
どこにも書かない):

```json
{
  "mcpServers": {
    "luvira-memory": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headersHelper": "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& (Join-Path $env:USERPROFILE 'Documents\\luvira-memory-mcp\\scripts\\windows\\get-luvira-mcp-headers.ps1')\""
    }
  }
}
```

- `type: http`:ネイティブの Streamable HTTP MCP 接続。
- `url`:ループバックのみ(`127.0.0.1:8765`)。LAN やコンテナ越しのアドレスは使わない。
- `headersHelper`:接続の都度 PowerShell スクリプトを起動し、標準出力の
  `Authorization` ヘッダー JSON だけを読み取らせる。

`.mcp.json`(プロジェクトスコープ)は使用しない: プロジェクトごとに MCP サーバーの
コミットと信頼確認が必要になり、`headersHelper` の参照パスがリポジトリごとに
重複・分散する。user-scope の `~/.claude.json` に一度登録すれば、ローカルの
すべてのプロジェクトから同一設定で再利用できる。

User/Machine 環境変数に資格情報を永続化しない: 環境変数として設定すると、同一
マシン上の他プロセスからの参照・ダンプ・シェル履歴など露出面が持続的に広がる。
`headersHelper` は接続の都度 ignore 対象の `.env` だけを読み、呼び出し元プロセスの
生存期間内でしか値を保持しない。

### セキュリティ

- 資格情報の取得元は Git 管理外の `luvira-memory-mcp/.env`(`LUVIRA_MCP_API_KEY`)のみ。
- `~/.claude.json` に資格情報の実値は保存しない(`headersHelper` の起動コマンド
  のみを保存する)。
- Git へ資格情報を保存しない。
- コマンドライン引数へ資格情報の実値を渡さない。`headersHelper` は標準出力にのみ
  出力し、呼び出し元がプロセス起動引数として資格情報を受け取ることはない。
- helper は対象の資格情報(`LUVIRA_MCP_API_KEY`)だけを読み、`.env` 内の他の値を
  読み出したり export したりしない。
- MCP ポートを LAN へ公開しない。バインドは `127.0.0.1:8765` のみ
  ([security.md](security.md) の Exposure limitation に従う)。
- user-scope MCP として登録するため、Claude Code のすべてのローカルプロジェクト
  から同一の `luvira-memory` 設定が利用可能になる。プロジェクトごとに信頼可否を
  判断する `.mcp.json` 方式とは前提が異なる点に注意する。

### Memory write policy

Luvira Memory は複数クライアント間で共有される長期コンテキストである。Claude
Code Desktop からの利用でも次を原則とする:

- `memory_search` / `memory_get` は通常の read 操作として扱う。
- `memory_add` は意図して永続化したい Memory にのみ使う。
- `memory_update` / `memory_delete` は既存 Memory への影響を伴うため慎重に扱う。
- credential・token・secret を Memory 本文へ保存しない。
- プロジェクト固有の一時情報を無条件に共有 Memory へ保存しない。
- 信頼していない外部コンテンツ(Web ページ、第三者から受け取ったファイルなど)を
  自動的に Memory へ保存しない。

これらは現時点ではクライアント側の運用ルールであり、Gateway 側での
permission enforcement(書き込み種別ごとの強制的なアクセス制御)としては
実装されていない。

### セットアップ / 検証

1. Luvira Memory スタックを起動する(前掲の「Luvira Memory MCP」節:
   `docker compose up -d --wait`、`/health/live` と `/health/ready` が HTTP 200)。
2. helper を直接実行し、`Authorization` の JSON が標準出力に 1 行だけ出ることを
   確認する:
   ```powershell
   Set-Location <Documents>\luvira-memory-mcp
   .\scripts\windows\get-luvira-mcp-headers.ps1
   ```
3. `~/.claude.json` のトップレベル `mcpServers` に上記の `luvira-memory` エントリ
   を登録する。
4. Claude Desktop を完全終了する。
5. Claude Desktop を通常どおり起動する。
6. 新しい Local Code session を作成する。
7. そのセッションで `luvira-memory` の tool が認識されていることを確認する
   (`mcp__luvira-memory__*`)。
8. `memory_search` を 1 回呼び出す。
9. 結果が存在する場合のみ、その中の 1 件に対して `memory_get` を 1 回呼び出す。
10. write tool(`memory_add` / `memory_update` / `memory_delete`)は使用せず、
    read-only 経路のみで E2E を確認する。

### ローテーション

`LUVIRA_MCP_API_KEY` をローテーションした場合:

- `luvira-memory-mcp/.env` を安全に更新する(値そのものをドキュメントや手順書に
  書かない)。
- Gateway(Mem0 側の認証設定)と資格情報の発行元との整合を維持する。
- `headersHelper` は次回接続時に `.env` から最新値を読むため、追加のキャッシュ
  クリア操作は不要。
- 必要に応じて、Claude Desktop で新しい Local session を開き、read-only の E2E
  (`memory_search`、該当時のみ `memory_get`)で再確認する。

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
