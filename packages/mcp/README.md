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
