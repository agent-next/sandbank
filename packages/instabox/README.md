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
| `asRoot` | — | `true` | When true (default), exec/writeFile/readFile run as root via `sudo -n -E`; set false to run as the guest user |

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

- **sleep / wake** map to InstaBox `suspend` / `resume` (both wait for the operation to finish).
- **exposePort** publishes the port and returns its public URL.
- Snapshots: InstaBox has no in-place restore, so sandboxes expose no snapshot interface. Save one with
  the client (`createInstaBoxRestClient().createSnapshot`) or the dashboard, then pass `image: 'sn_...'`
  to `create()` to start a new sandbox from it.
- Not supported: `exec.stream`, `terminal`, `volumes`, `services`, `snapshot` (restore).

## Characteristics and limits

- **Runtime:** Full VM, fixed size 4 vCPU / 8 GiB — `CreateConfig.resources` is ignored
  (sending size fields is rejected with `400 spec_not_allowed`).
- **Free tier:** 5 machines.
- **Lifetime:** `autoDestroyMinutes` (when > 0) maps to `timeoutSeconds`, clamped to 60 s – 4 h
  (the server clamps anything beyond 4 h silently); timeout action is `kill`. Omitted or `0`
  sends no timeout — the machine is not auto-destroyed.
- **Execution identity:** by default every exec/writeFile/readFile runs as root via
  `sudo -n -E bash -lc '<command>'` (cwd and env are preserved); `asRoot: false` runs as the
  guest user unchanged.
- **Idle auto-pause:** sandboxes pause after 30 idle minutes (fixed on non-manual-lifecycle accounts);
  `wake()` / the next call resumes them.
- **Lifecycle ops** (`create`/`destroy`/`start`/`stop`/`suspend`/`resume`) are asynchronous: the adapter
  sends an `Idempotency-Key` and long-polls `GET /v1/operations/{id}?wait=25s` until the operation
  succeeds; a failed operation raises `ProviderError` with its `error.code`/`message`.
- **Files:** `readFile` uses the files endpoint for text files (≤ 256 KiB); binary or oversized files
  fall back to chunked `dd | base64` through exec (512 KiB chunks, stdout caps at 1 MiB; a
  `truncated` response raises `ProviderError`). `writeFile` streams base64 content
  through exec stdin (≤ 1 MiB) — InstaBox has no file-write endpoint.
- **Env vars** are stored on the sandbox object and replayed as exec `envs` (InstaBox has no
  create-time env injection); they survive `provider.get()` within the same process but are not
  recoverable in a new process.
- **Retries:** only GETs retry once on retryable `429`/`503`; mutating lifecycle calls are not
  retried (they carry an `Idempotency-Key`).
- Every machine is created with `metadata: { source: 'sandbank' }` and a generated `sb-…` name.

## License

MIT
