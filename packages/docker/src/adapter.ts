import type {
  AdapterSandbox,
  Capability,
  CreateConfig,
  ExecOptions,
  ExecResult,
  ListFilter,
  SandboxAdapter,
  SandboxInfo,
  SandboxState,
  VolumeConfig,
  VolumeInfo,
} from '@sandbank.dev/core'
import { ExecTimeoutError, ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDockerCli } from './cli.js'
import type { DockerCli, DockerRunOptions } from './cli.js'
import type { DockerAdapterConfig } from './types.js'

const MANAGED_LABEL = 'sandbank.managed=true'
const DEFAULT_IMAGE = 'ubuntu:24.04'
const DEFAULT_EXEC_TIMEOUT_MS = 120_000

interface ContainerInspect {
  Id: string
  Created: string
  Config: { Image: string; Labels?: Record<string, string> | null }
  State: { Status: string }
  Mounts?: Array<{ Type: string; Name?: string }>
}

function mapState(status: string): SandboxState {
  switch (status) {
    case 'running':
    case 'restarting':
      return 'running'
    case 'created':
      return 'creating'
    case 'paused':
    case 'exited':
      return 'stopped'
    default:
      return 'terminated'
  }
}

function isNotFound(stderr: string): boolean {
  return /No such (container|object|volume)/i.test(stderr)
}

/** docker's own message when an exec targets a missing container (user output could mimic it; confirm with inspect). */
const CONTAINER_GONE = /^Error response from daemon: No such container/m

/** Kill the process tree rooted at the pid in "$0" (pure sh + /proc, no procps needed). */
const KILL_TREE = 'k(){ for c in $(cat /proc/$1/task/*/children 2>/dev/null); do k $c; done; kill -KILL $1 2>/dev/null; }; '
  + 'p=$(cat "$0" 2>/dev/null) && k $p; rm -f "$0"'

/** Runs "$1" under a wrapper whose pid is recorded in "$0", so a timeout or cancel can kill the whole tree. */
const TRACKED = 'echo $$ > "$0"; sh -c "$1"; s=$?; rm -f "$0"; exit $s'

const decoder = new TextDecoder()

export class DockerAdapter implements SandboxAdapter {
  readonly name = 'docker'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'exec.stream',
    'sleep',
    'port.expose',
    'volumes',
  ])

  private readonly cli: DockerCli
  private readonly config: DockerAdapterConfig

  constructor(config: DockerAdapterConfig = {}, cli?: DockerCli) {
    this.config = config
    this.cli = cli ?? createDockerCli(config.binary)
  }

  private async runCli(args: string[], id?: string, options?: DockerRunOptions) {
    try {
      return await this.cli.run(args, options)
    } catch (err) {
      throw new ProviderError('docker', err, id)
    }
  }

  /** Run docker and return stdout as text; throw ProviderError / SandboxNotFoundError on failure. */
  private async docker(args: string[], id?: string, options?: DockerRunOptions): Promise<string> {
    const result = await this.runCli(args, id, options)
    if (result.exitCode !== 0) {
      if (id && isNotFound(result.stderr)) throw new SandboxNotFoundError('docker', id)
      throw new ProviderError('docker', new Error(result.stderr.trim() || `docker ${args[0]} exited ${result.exitCode}`), id)
    }
    return decoder.decode(result.stdout)
  }

  /** Inspect containers, skipping ids that no longer exist (e.g. a `--rm` sandbox that just expired). */
  private async inspect(ids: string[]): Promise<ContainerInspect[]> {
    if (!ids.length) return []
    const result = await this.runCli(['container', 'inspect', ...ids])
    const stdout = decoder.decode(result.stdout).trim()
    if (result.exitCode !== 0 && !isNotFound(result.stderr)) {
      throw new ProviderError('docker', new Error(result.stderr.trim() || 'docker inspect failed'))
    }
    return stdout.startsWith('[') ? JSON.parse(stdout) : []
  }

  private async managed(id: string): Promise<ContainerInspect | undefined> {
    const [info] = await this.inspect([id])
    return info?.Config.Labels?.['sandbank.managed'] === 'true' ? info : undefined
  }

  private async managedIds(): Promise<string[]> {
    return (await this.docker(['ps', '-aq', '--no-trunc', '--filter', `label=${MANAGED_LABEL}`]))
      .split('\n').map(s => s.trim()).filter(Boolean)
  }

  private wrap(info: ContainerInspect): AdapterSandbox {
    const id = info.Id.slice(0, 12)
    const cli = this.cli
    const docker = this.docker.bind(this)
    const runCli = this.runCli.bind(this)
    const managed = this.managed.bind(this)
    const publicHost = this.config.publicHost ?? '127.0.0.1'
    let state = mapState(info.State.Status)

    const tracked = (command: string, options?: ExecOptions) => {
      const pidFile = `/tmp/.sandbank-exec-${randomUUID()}.pid`
      return {
        args: ['exec', ...(options?.cwd ? ['-w', options.cwd] : []), id, 'sh', '-c', TRACKED, pidFile, command],
        kill: () => cli.run(['exec', id, 'sh', '-c', KILL_TREE, pidFile]).catch(() => undefined),
      }
    }

    return {
      id,
      get state() { return state },
      createdAt: new Date(info.Created).toISOString(),

      async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
        const timeout = options?.timeout ?? DEFAULT_EXEC_TIMEOUT_MS
        const run = tracked(command, options)
        const result = await runCli(run.args, id, { timeoutMs: timeout })
        if (result.timedOut) {
          await run.kill()
          throw new ExecTimeoutError('docker', id, timeout)
        }
        if (result.exitCode !== 0 && CONTAINER_GONE.test(result.stderr) && !(await managed(id))) {
          throw new SandboxNotFoundError('docker', id)
        }
        return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout), stderr: result.stderr }
      },

      async execStream(command: string, options?: ExecOptions): Promise<ReadableStream<Uint8Array>> {
        const run = tracked(command, options)
        return cli.stream(run.args, { onCancel: () => { void run.kill() } })
      },

      async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        const input = typeof content === 'string' ? new TextEncoder().encode(content) : content
        await docker(
          ['exec', '-i', id, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', path],
          id,
          { input },
        )
      },

      async readFile(path: string): Promise<Uint8Array> {
        const result = await runCli(['exec', id, 'cat', '--', path], id)
        if (result.exitCode !== 0) {
          if (CONTAINER_GONE.test(result.stderr)) throw new SandboxNotFoundError('docker', id)
          throw new ProviderError('docker', new Error(result.stderr.trim()), id)
        }
        return result.stdout
      },

      async sleep(): Promise<void> {
        await docker(['pause', id], id)
        state = 'stopped'
      },

      async wake(): Promise<void> {
        await docker(['unpause', id], id)
        state = 'running'
      },

      async exposePort(port: number): Promise<{ url: string }> {
        const out = await docker(['port', id, `${port}/tcp`], id).catch(() => '')
        const hostPort = out.split('\n')[0]?.split(':').pop()?.trim()
        if (!hostPort) {
          throw new ProviderError(
            'docker',
            new Error(`port ${port} is not published; pass ports: [[hostPort, ${port}]] at create`),
            id,
          )
        }
        return { url: `http://${publicHost}:${hostPort}` }
      },
    }
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const env = Object.entries(config.env ?? {})
    for (const [name, value] of env) {
      if (!/^[^#=\r\n][^=\r\n]*$/.test(name) || /[\r\n]/.test(value)) {
        throw new ProviderError('docker', new Error(`env ${name}: names cannot start with '#' or contain '=', values must be single-line`))
      }
    }
    const autoDestroySeconds = (config.autoDestroyMinutes ?? 0) * 60
    // Env values reach docker through a private env file: never argv, never the docker CLI's own env.
    const envDir = env.length ? await mkdtemp(join(tmpdir(), 'sandbank-env-')) : undefined
    const envFile = envDir ? join(envDir, 'env') : undefined
    const bindHost = this.config.bindHost ?? '127.0.0.1'

    const args = [
      'run', '-d', '--init',
      '--label', MANAGED_LABEL,
      ...(autoDestroySeconds > 0 ? ['--rm'] : []),
      ...(envFile ? ['--env-file', envFile] : []),
      ...(config.resources?.cpu ? ['--cpus', String(config.resources.cpu)] : []),
      ...(config.resources?.memory ? ['--memory', `${config.resources.memory}m`] : []),
      ...(config.ports ?? []).flatMap(([host, guest]) => ['-p', `${bindHost}:${host}:${guest}`]),
      ...(config.volumes ?? []).flatMap(v => ['-v', `${v.id}:${v.mountPath}`]),
      ...(this.config.runArgs ?? []),
      '--entrypoint', autoDestroySeconds > 0 ? 'sleep' : 'tail',
      config.image ?? this.config.defaultImage ?? DEFAULT_IMAGE,
      ...(autoDestroySeconds > 0 ? [String(autoDestroySeconds)] : ['-f', '/dev/null']),
    ]

    let id: string
    try {
      if (envFile) await writeFile(envFile, env.map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 })
      id = (await this.docker(args)).trim()
    } finally {
      if (envDir) await rm(envDir, { recursive: true, force: true })
    }
    const [info] = await this.inspect([id])
    if (!info) throw new ProviderError('docker', new Error(`container ${id} vanished after create`), id)
    return this.wrap(info)
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const info = await this.managed(id)
    if (!info) throw new SandboxNotFoundError('docker', id)
    return this.wrap(info)
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    const wanted = filter?.state ? new Set(Array.isArray(filter.state) ? filter.state : [filter.state]) : null

    const sandboxes = (await this.inspect(await this.managedIds()))
      .map(info => ({
        id: info.Id.slice(0, 12),
        state: mapState(info.State.Status),
        createdAt: new Date(info.Created).toISOString(),
        image: info.Config.Image,
      }))
      .filter(s => !wanted || wanted.has(s.state))
    return filter?.limit ? sandboxes.slice(0, filter.limit) : sandboxes
  }

  async destroySandbox(id: string): Promise<void> {
    // Only ever remove containers sandbank created; anything else counts as not found.
    const info = await this.managed(id)
    if (!info) return
    try {
      await this.docker(['rm', '-f', '-v', info.Id], id)
    } catch (err) {
      if (err instanceof SandboxNotFoundError) return
      throw err
    }
  }

  async createVolume(config: VolumeConfig): Promise<VolumeInfo> {
    const name = (await this.docker(['volume', 'create', '--label', MANAGED_LABEL, config.name])).trim()
    return { id: name, name, sizeGB: config.sizeGB ?? 0, attachedTo: null }
  }

  async deleteVolume(id: string): Promise<void> {
    const result = await this.runCli(['volume', 'inspect', '--format', '{{index .Labels "sandbank.managed"}}', id], id)
    if (result.exitCode !== 0 || decoder.decode(result.stdout).trim() !== 'true') return
    try {
      await this.docker(['volume', 'rm', id], id)
    } catch (err) {
      if (err instanceof SandboxNotFoundError) return
      throw err
    }
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const names = (await this.docker(['volume', 'ls', '-q', '--filter', `label=${MANAGED_LABEL}`]))
      .split('\n').map(s => s.trim()).filter(Boolean)
    const attached = new Map<string, string>()
    for (const sandbox of await this.inspect(await this.managedIds())) {
      for (const mount of sandbox.Mounts ?? []) {
        if (mount.Type === 'volume' && mount.Name) attached.set(mount.Name, sandbox.Id.slice(0, 12))
      }
    }
    return names.map(name => ({ id: name, name, sizeGB: 0, attachedTo: attached.get(name) ?? null }))
  }
}
