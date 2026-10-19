# @sandbank.dev/instabox

> [InstaBox](https://instabox.sh) cloud sandbox adapter for [Sandbank](../../README.md).

## Install

```bash
pnpm add @sandbank.dev/core @sandbank.dev/instabox
```

## Configuration

| Option | Env var | Default | Description |
|--------|---------|---------|-------------|
| `apiKey` | `INSTABOX_API_KEY` | — | InstaBox API key (required) |
| `apiUrl` | `INSTABOX_API_URL` | `https://api.instabox.sh` | API base URL |
| `template` | — | `universal` | Template id used when `CreateConfig.image` is not set |

## Usage

```typescript
import { createProvider } from '@sandbank.dev/core'
import { InstaBoxAdapter } from '@sandbank.dev/instabox'

const provider = createProvider(
  new InstaBoxAdapter({
    apiKey: process.env.INSTABOX_API_KEY!,
  })
)

const sandbox = await provider.create({
  image: 'universal',          // template id, or 'sn_...' to start from a snapshot
  autoDestroyMinutes: 60,      // clamped to the API's 60 s – 4 h lifetime window
  env: { FOO: 'bar' },         // replayed on every exec call
})

const { stdout } = await sandbox.exec('node --version')
await sandbox.writeFile('/tmp/index.js', 'console.log("hello")')
await provider.destroy(sandbox.id) // idempotent; 404 is already gone
```

API reference: https://instabox.sh/docs/api

## Capabilities

| Capability | Supported |
|------------|:---------:|
| `sleep` | ✅ |
| `port.expose` | ✅ |
| `snapshot` | ✅ |

- **sleep / wake** map to InstaBox `suspend` / `resume` (both wait for the operation to finish).
- **exposePort** publishes the port and returns its public URL.
- **createSnapshot** polls `GET /v1/snapshots/{id}` until the upload is `ready`. InstaBox has no
  in-place restore — pass `image: 'sn_...'` to `create()` to start a new sandbox from a snapshot.
- Not supported: `exec.stream`, `terminal`, `volumes`, `services`.

## Characteristics and limits

- **Runtime:** Full VM, fixed size 4 vCPU / 8 GiB — `CreateConfig.resources` is ignored
  (sending size fields is rejected with `400 spec_not_allowed`).
- **Free tier:** 5 machines.
- **Lifetime:** `autoDestroyMinutes` maps to `timeoutSeconds`, clamped to 60 s – 4 h
  (the server clamps anything beyond 4 h silently). Timeout action is `kill`.
- **Idle auto-pause:** sandboxes pause after 30 idle minutes (fixed on non-manual-lifecycle accounts);
  `wake()` / the next call resumes them.
- **Lifecycle ops** (`create`/`destroy`/`start`/`stop`/`suspend`/`resume`) are asynchronous: the adapter
  sends an `Idempotency-Key` and long-polls `GET /v1/operations/{id}?wait=25s` until the operation
  succeeds; a failed operation raises `ProviderError` with its `error.code`/`message`.
- **Files:** `readFile` uses the files endpoint for text files (≤ 256 KiB); binary or oversized files
  fall back to `base64` through exec (stdout caps at 1 MiB). `writeFile` streams base64 content
  through exec stdin (≤ 1 MiB) — InstaBox has no file-write endpoint.
- **Env vars** are stored on the sandbox object and replayed as exec `envs` (InstaBox has no
  create-time env injection); they are not recoverable via `provider.get()` in a new process.
- **Retries:** idempotency-keyed lifecycle calls and GETs handle `429`/`503 retryable` (one retry on GETs).
- Every machine is created with `metadata: { source: 'sandbank' }` and a generated `sb-…` name.

## License

MIT
