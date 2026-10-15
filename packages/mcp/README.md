# @sandbank.dev/mcp

> [MCP](https://modelcontextprotocol.io) server for [Sandbank](../../README.md) sandboxes, with an [MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/) console UI.

Providers: `docker` (always available) and `sbx` (when `SBX_API_KEY` or `E2B_API_KEY` is set).

## Run

```bash
npx @sandbank.dev/mcp                 # stdio
npx @sandbank.dev/mcp --http 3000     # Streamable HTTP at http://127.0.0.1:3000/mcp
```

Claude Code: `claude mcp add sandbank -- npx -y @sandbank.dev/mcp`

## Tools

| tool | purpose |
|---|---|
| `providers_list` | providers, configured flag, capabilities |
| `sandbox_create` / `sandbox_list` / `sandbox_destroy` | lifecycle |
| `sandbox_exec` | run a command, returns exit code, stdout, stderr, duration |
| `file_read` / `file_write` | utf8 or base64 file transfer |
| `port_expose` | URL for a sandbox port |
| `render_view` | renders an OpenUI Lang program (`ui://sandbank/view-v1.html`) |
| `render_console` | opens the interactive console (`ui://sandbank/console-v1.html`, mimeType `text/html;profile=mcp-app`) |

Every tool returns `structuredContent` plus a text summary; failures return `isError: true`.

## Embedding

```typescript
import { createServer } from '@sandbank.dev/mcp'

const server = createServer({ registry }) // registry: { [name]: { configured, get(): SandboxProvider } }
```

## Test

```bash
npx vitest run packages/mcp
DOCKER_INTEGRATION=1 npx vitest run packages/mcp/test/docker.integration.test.ts  # real docker, alpine:3.20
```

## Hosted mode (remote connectors)

Claude and ChatGPT custom connectors need a public HTTPS URL. Set a secret path token and run the HTTP server:

```bash
export SANDBANK_MCP_TOKEN=$(openssl rand -hex 24)   # >= 32 chars; the URL path is the credential
export SANDBANK_MCP_PROVIDERS=sbx                    # optional: hide docker on a shared host
sandbank-mcp --http 8080                             # serves /mcp/$SANDBANK_MCP_TOKEN on 0.0.0.0
```

Put it behind HTTPS (for example in an sbx sandbox, whose port URL is `https://8080-<id>.sbx.agent-next.com`) and add `https://<host>/mcp/<token>` as the connector URL. Every other path returns 404. Treat the URL like an API key.

