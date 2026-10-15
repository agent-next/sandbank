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

  /** Run docker and return stdout as text; throw ProviderError / SandboxNotFoundError on failure. */
  private async docker(args: string[], id?: string, options?: DockerRunOptions): Promise<string> {
    let result
    try {
      result = await this.cli.run(args, options)
    } catch (err) {
      throw new ProviderError('docker', err, id)
    }
    if (result.exitCode !== 0) {
      if (id && isNotFound(result.stderr)) throw new SandboxNotFoundError('docker', id)
      throw new ProviderError('docker', new Error(result.stderr.trim() || `docker ${args[0]} exited ${result.exitCode}`), id)
    }
    return decoder.decode(result.stdout)
  }

  private async inspect(ids: string[]): Promise<ContainerInspect[]> {
    if (!ids.length) return []
    return JSON.parse(await this.docker(['container', 'inspect', ...ids], ids.length === 1 ? ids[0] : undefined))
  }

  private async managedIds(): Promise<string[]> {
    return (await this.docker(['ps', '-aq', '--no-trunc', '--filter', `label=${MANAGED_LABEL}`]))
      .split('\n').map(s => s.trim()).filter(Boolean)
  }

  private wrap(info: ContainerInspect): AdapterSandbox {
    const id = info.Id.slice(0, 12)
    const cli = this.cli
    const docker = this.docker.bind(this)
    const publicHost = this.config.publicHost ?? '127.0.0.1'
    let state = mapState(info.State.Status)

    const execArgs = (command: string, options?: ExecOptions, interactive = false): string[] => [
      'exec',
      ...(interactive ? ['-i'] : []),
      ...(options?.cwd ? ['-w', options.cwd] : []),
      id, 'sh', '-c', command,
    ]

    return {
      id,
      get state() { return state },
      createdAt: new Date(info.Created).toISOString(),

      async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
        const timeout = options?.timeout ?? DEFAULT_EXEC_TIMEOUT_MS
        let result
        try {
          result = await cli.run(execArgs(command, options), { timeoutMs: timeout })
        } catch (err) {
          throw new ProviderError('docker', err, id)
        }
        if (result.timedOut) throw new ExecTimeoutError('docker', id, timeout)
        if (result.exitCode !== 0 && isNotFound(result.stderr)) throw new SandboxNotFoundError('docker', id)
        return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout), stderr: result.stderr }
      },

      async execStream(command: string, options?: ExecOptions): Promise<ReadableStream<Uint8Array>> {
        return cli.stream(execArgs(command, options))
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
        let result
        try {
          result = await cli.run(['exec', id, 'cat', '--', path])
        } catch (err) {
          throw new ProviderError('docker', err, id)
        }
        if (result.exitCode !== 0) {
          if (isNotFound(result.stderr)) throw new SandboxNotFoundError('docker', id)
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
    const env = config.env ?? {}
    const autoDestroySeconds = (config.autoDestroyMinutes ?? 0) * 60
    const bindHost = this.config.bindHost ?? '127.0.0.1'

    const args = [
      'run', '-d', '--init',
      '--label', MANAGED_LABEL,
      ...(autoDestroySeconds > 0 ? ['--rm'] : []),
      ...Object.keys(env).flatMap(name => ['-e', name]),
      ...(config.resources?.cpu ? ['--cpus', String(config.resources.cpu)] : []),
      ...(config.resources?.memory ? ['--memory', `${config.resources.memory}m`] : []),
      ...(config.ports ?? []).flatMap(([host, guest]) => ['-p', `${bindHost}:${host}:${guest}`]),
      ...(config.volumes ?? []).flatMap(v => ['-v', `${v.id}:${v.mountPath}`]),
      ...(this.config.runArgs ?? []),
      '--entrypoint', autoDestroySeconds > 0 ? 'sleep' : 'tail',
      config.image ?? this.config.defaultImage ?? DEFAULT_IMAGE,
      ...(autoDestroySeconds > 0 ? [String(autoDestroySeconds)] : ['-f', '/dev/null']),
    ]

    // Env values travel through the docker process environment (`-e NAME`), never argv.
    const id = (await this.docker(args, undefined, { env })).trim()
    const [info] = await this.inspect([id])
    if (!info) throw new ProviderError('docker', new Error(`container ${id} vanished after create`), id)
    return this.wrap(info)
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const [info] = await this.inspect([id])
    if (!info || info.Config.Labels?.['sandbank.managed'] !== 'true') throw new SandboxNotFoundError('docker', id)
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
    try {
      await this.docker(['rm', '-f', '-v', id], id)
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
