# @sandbank.dev/docker

> Local Docker container adapter for [Sandbank](../../README.md).

Runs each sandbox as a Docker container through the `docker` CLI. No SDK dependency; it honors `DOCKER_HOST` and Docker contexts, so it also works against a remote daemon. Good for local development, CI, self-hosted GPU boxes (`runArgs: ['--gpus', 'all']`), and offline runs.

Containers are not a strong security boundary. For untrusted code, use a microVM provider (sbx, E2B, BoxLite, Fly.io) or a hardened runtime such as gVisor (`runArgs: ['--runtime', 'runsc']`).

## Install

```bash
pnpm add @sandbank.dev/core @sandbank.dev/docker
```

## Usage

```typescript
import { createProvider, withPortExpose, withVolumes } from '@sandbank.dev/core'
import { DockerAdapter } from '@sandbank.dev/docker'

const provider = createProvider(new DockerAdapter({ defaultImage: 'node:22' }))

const volume = await withVolumes(provider)!.createVolume({ name: 'agent-data' })
const sandbox = await provider.create({
  env: { NODE_ENV: 'development' },
  ports: [[0, 3000]],                       // 0 = any free host port
  volumes: [{ id: volume.id, mountPath: '/data' }],
  resources: { cpu: 2, memory: 2048 },      // memory in MB
})

await sandbox.exec('node -e "console.log(process.version)"')
const { url } = await withPortExpose(sandbox)!.exposePort(3000) // http://127.0.0.1:<hostPort>

await provider.destroy(sandbox.id)
```

## Behavior

- Every container is labeled `sandbank.managed=true`; `list()` and `get()` only see labeled containers.
- The container runs `tail -f /dev/null` under `--init`, so any image with `sh` works. `autoDestroyMinutes` runs `sleep <seconds>` with `--rm` instead, so the container removes itself.
- `env` values go to docker through a private (0600) temp env file that is deleted right after create; they never appear in argv. Values must be single-line.
- Published ports bind to `127.0.0.1` by default (`bindHost` to change). `exposePort` only works for ports published at create.
- `exec` timeouts raise `ExecTimeoutError` and kill the command's whole process tree inside the container; cancelling an `execStream` does the same.
- `destroy()` runs `docker rm -f -v`, is idempotent, and never touches containers without the sandbank label. `deleteVolume()` likewise only removes labeled volumes.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `binary` | `docker` | CLI binary path |
| `defaultImage` | `ubuntu:24.04` | Image when `image` is omitted |
| `bindHost` | `127.0.0.1` | Host interface for published ports |
| `publicHost` | `127.0.0.1` | Host name in `exposePort` URLs |
| `runArgs` | `[]` | Extra `docker run` flags (`--gpus all`, `--network none`, `--runtime runsc`) |

## Capabilities

| Capability | Supported |
|------------|:---------:|
| `exec.stream` | ✅ (stdout + stderr) |
| `sleep` | ✅ (`docker pause` / `unpause`) |
| `port.expose` | ✅ (ports published at create) |
| `volumes` | ✅ (Docker named volumes) |
| `snapshot`, `terminal` | ❌ |

## Tests

Unit tests run with `pnpm test`. Integration tests against a real daemon: `DOCKER_INTEGRATION=1 pnpm vitest run packages/docker` (uses `alpine:3.20`, override with `DOCKER_TEST_IMAGE`).
