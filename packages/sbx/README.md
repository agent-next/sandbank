# @sandbank.dev/sbx

> [agent-next sandbox](https://github.com/agent-next/sandbox) (sbx) adapter for [Sandbank](../../README.md).

sbx is a hosted cloud sandbox that speaks the E2B API (CPU and GPU templates). This adapter drives it through the E2B SDK with sbx endpoints and defaults. `image` maps to an sbx template name.

## Install

```bash
pnpm add @sandbank.dev/core @sandbank.dev/sbx
```

## Usage

```typescript
import { createProvider, withPortExpose } from '@sandbank.dev/core'
import { SbxAdapter } from '@sandbank.dev/sbx'

// Reads SBX_API_KEY (or E2B_API_KEY). Create a key at https://sbx.agent-next.com/console
const provider = createProvider(new SbxAdapter())

const sandbox = await provider.create({ image: 'base', env: { NODE_ENV: 'development' } })
const { stdout } = await sandbox.exec('python3 -c "print(6 * 7)"')

const { url } = await withPortExpose(sandbox)!.exposePort(8000)
// https://8000-<sandbox-id>.sbx.agent-next.com

await provider.destroy(sandbox.id)
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | `SBX_API_KEY`, then `E2B_API_KEY` | sbx API key |
| `domain` | `SBX_DOMAIN`, then `sbx.agent-next.com` | Base domain (self-hosted gateways) |
| `apiUrl` | `https://api.${domain}` | API URL override |
| `template` | sbx default | Template used when `image` is omitted |
| `autoDestroyMinutes` | `60` | Lifetime when `create()` sets none. sbx sandboxes are killed, not paused, at the end |
| `requestTimeoutMs` | SDK default | Per-request timeout |

## Capabilities

| Capability | Supported |
|------------|:---------:|
| `terminal` | ✅ (ttyd) |
| `sleep` | ✅ (pause / resume) |
| `port.expose` | ✅ (`https://<port>-<id>.<domain>`) |
| `volumes` | ❌ |

## Tests

Unit tests run with `pnpm test`. The integration test runs against a real sbx endpoint when `SBX_API_KEY` is set; it creates one sandbox with a 10-minute lifetime and destroys it.
