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
} from '@sandbank.dev/core'
import { ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'
import type {
  InstaBoxAdapterConfig,
  InstaBoxClient,
  InstaBoxCreateMachineRequest,
  InstaBoxMachine,
  InstaBoxOperation,
} from './types.js'
import { createInstaBoxRestClient, InstaBoxApiError } from './rest-client.js'

export type { InstaBoxAdapterConfig }

const DEFAULT_API_URL = 'https://api.instabox.sh'
const DEFAULT_TEMPLATE = 'universal'

// InstaBox sandboxes are a fixed size (4 vCPU / 8 GiB); resources are ignored.
// Lifetime maps to timeoutSeconds, clamped to the API's 60 s minimum and a 4 h cap
// (the server silently clamps beyond 4 h anyway unless the account has manual lifecycle).
const MIN_TIMEOUT_SECONDS = 60
const MAX_TIMEOUT_SECONDS = 14400
const DEFAULT_TIMEOUT_MINUTES = 60

// exec runs through `bash -lc` with a 60 s default / 600 s max per the API.
const DEFAULT_EXEC_TIMEOUT_SECONDS = 60
const MAX_EXEC_TIMEOUT_SECONDS = 600

// Lifecycle ops are long-polled (?wait=25s, server caps at 30s); bounded to ~25 min.
const OP_POLL_SECONDS = 25
const OP_MAX_ATTEMPTS = 60

// Snapshots have no long-poll endpoint; poll GET /v1/snapshots/{id}.
const SNAPSHOT_POLL_MS = 2000
const SNAPSHOT_MAX_ATTEMPTS = 150

/** Label set on every machine we create, so integration runs can assert cleanup. */
const METADATA_LABEL = { source: 'sandbank' }

/** Map InstaBox's MachineState to our SandboxState */
function mapState(state: string): SandboxState {
  switch (state) {
    case 'creating':
    case 'starting':
    case 'resuming':
      return 'creating'
    case 'running':
      return 'running'
    case 'stopping':
    case 'stopped':
    case 'suspending':
    case 'suspended':
      return 'stopped'
    case 'deleting':
    case 'deleted':
      return 'terminated'
    case 'error':
    default:
      return 'error'
  }
}

function toTimeoutSeconds(minutes?: number): number {
  const seconds = (minutes ?? DEFAULT_TIMEOUT_MINUTES) * 60
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, seconds))
}

function toExecTimeoutSeconds(ms?: number): number {
  if (ms == null) return DEFAULT_EXEC_TIMEOUT_SECONDS
  return Math.min(MAX_EXEC_TIMEOUT_SECONDS, Math.max(1, Math.round(ms / 1000)))
}

/** Machine name: 1-63 of a-z, 0-9, '-'. */
function generateName(): string {
  return `sb-${crypto.randomUUID().slice(0, 8)}`
}

/** Snapshot name: 1-63 of a-z, 0-9, '-', starting with a letter or digit. */
function generateSnapshotName(): string {
  return `snap-${crypto.randomUUID().slice(0, 8)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Poll an operation until it succeeds; throw ProviderError on failure/timeout. */
async function waitForOperation(client: InstaBoxClient, op: InstaBoxOperation): Promise<InstaBoxOperation> {
  for (let i = 0; i < OP_MAX_ATTEMPTS; i++) {
    if (op.state === 'succeeded') return op
    if (op.state === 'failed') {
      const code = op.error?.code ?? 'unknown'
      const message = op.error?.message ?? 'no message'
      throw new ProviderError('instabox', new Error(`Operation ${op.type} failed: ${code}: ${message}`), op.machineId)
    }
    op = await client.getOperation(op.id, OP_POLL_SECONDS)
  }
  throw new ProviderError('instabox', new Error(`Timed out waiting for operation ${op.id}`), op.machineId)
}

/** Wrap machine data + client into an AdapterSandbox. `env` is replayed on every exec. */
function wrapSandbox(client: InstaBoxClient, data: InstaBoxMachine, env?: Record<string, string>): AdapterSandbox {
  return {
    get id() { return data.id },
    get state() { return mapState(data.state) },
    get createdAt() { return data.createdAt },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const result = await client.exec(data.id, {
        cmd: command,
        cwd: options?.cwd,
        envs: env,
        timeoutSeconds: toExecTimeoutSeconds(options?.timeout),
      })
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }
    },

    // No write endpoint: stream the base64'd content through exec stdin.
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const result = await client.exec(data.id, {
        cmd: `mkdir -p $(dirname ${shellQuote(path)}) && base64 -d > ${shellQuote(path)}`,
        stdin: toBase64(bytes),
      })
      if (result.exitCode !== 0) {
        throw new Error(`writeFile failed for '${path}': ${result.stderr || `exit ${result.exitCode}`}`)
      }
    },

    async readFile(path: string): Promise<Uint8Array> {
      const file = await client.readFile(data.id, path)
      if (file.type === 'file' && !file.binary && !file.truncated && file.content != null) {
        return new TextEncoder().encode(file.content)
      }
      // Binary or oversized file — fall back to base64 through exec (stdout caps at 1 MiB)
      const result = await client.exec(data.id, { cmd: `base64 -w0 ${shellQuote(path)}` })
      if (result.exitCode !== 0) {
        throw new Error(`readFile failed for '${path}': ${result.stderr || `exit ${result.exitCode}`}`)
      }
      return fromBase64(result.stdout.replace(/\s/g, ''))
    },

    async sleep(): Promise<void> {
      await waitForOperation(client, await client.machineAction(data.id, 'suspend'))
    },

    async wake(): Promise<void> {
      await waitForOperation(client, await client.machineAction(data.id, 'resume'))
    },

    async exposePort(port: number): Promise<{ url: string }> {
      const pub = await client.publishPort(data.id, port)
      return { url: pub.url }
    },

    async createSnapshot(name?: string): Promise<{ snapshotId: string }> {
      let current = await client.createSnapshot(data.id, name ?? generateSnapshotName())
      for (let i = 0; i < SNAPSHOT_MAX_ATTEMPTS; i++) {
        if (current.status === 'ready') return { snapshotId: current.id }
        if (current.status === 'failed') {
          throw new ProviderError(
            'instabox',
            new Error(`Snapshot '${current.name}' failed: ${current.error ?? 'unknown error'}`),
            data.id,
          )
        }
        await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_MS))
        current = await client.getSnapshot(current.id)
      }
      throw new ProviderError('instabox', new Error(`Timed out waiting for snapshot ${current.id}`), data.id)
    },
  }
}

export class InstaBoxAdapter implements SandboxAdapter {
  readonly name = 'instabox'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'sleep',
    'port.expose',
    'snapshot',
  ])

  private clientPromise: Promise<InstaBoxClient> | null = null
  private readonly config: InstaBoxAdapterConfig

  constructor(config: InstaBoxAdapterConfig) {
    this.config = config
  }

  /** Lazy-init client — resolves apiKey/apiUrl from config, else environment */
  private getClient(): Promise<InstaBoxClient> {
    if (!this.clientPromise) {
      const apiKey = this.config.apiKey ?? process.env['INSTABOX_API_KEY']
      if (!apiKey) {
        this.clientPromise = Promise.reject(
          new Error('InstaBox API key is required — pass apiKey or set INSTABOX_API_KEY'),
        )
      } else {
        const apiUrl = this.config.apiUrl ?? process.env['INSTABOX_API_URL'] ?? DEFAULT_API_URL
        this.clientPromise = Promise.resolve(createInstaBoxRestClient({ apiKey, apiUrl }))
      }
    }
    return this.clientPromise
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const client = await this.getClient()
    try {
      const body: InstaBoxCreateMachineRequest = {
        name: generateName(),
        timeoutSeconds: toTimeoutSeconds(config.autoDestroyMinutes),
        onTimeout: 'kill',
        metadata: METADATA_LABEL,
        vault: false,
      }
      // image starting with sn_ names a snapshot; anything else names a template
      if (config.image?.startsWith('sn_')) {
        body.snapshotId = config.image
      } else {
        body.templateId = config.image ?? this.config.template ?? DEFAULT_TEMPLATE
      }

      const op = await client.createMachine(body)
      const done = await waitForOperation(client, op)
      const machine = done.machine ?? await client.getMachine(op.machineId)
      return wrapSandbox(client, machine, config.env)
    } catch (err) {
      if (err instanceof ProviderError) throw err
      throw new ProviderError('instabox', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const client = await this.getClient()
    try {
      const machine = await client.getMachine(id)
      return wrapSandbox(client, machine)
    } catch (err) {
      if (err instanceof InstaBoxApiError && err.status === 404) {
        throw new SandboxNotFoundError('instabox', id)
      }
      throw new ProviderError('instabox', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    const client = await this.getClient()
    try {
      const infos: SandboxInfo[] = []
      let cursor: string | undefined
      do {
        const page = await client.listMachines({ cursor, limit: filter?.limit })
        for (const machine of page.machines) {
          infos.push({
            id: machine.id,
            state: mapState(machine.state),
            createdAt: machine.createdAt,
            image: machine.snapshot?.id ?? machine.name,
          })
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor && (filter?.limit == null || infos.length < filter.limit))

      let result = infos
      if (filter?.state) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state]
        result = result.filter((s) => states.includes(s.state))
      }
      return filter?.limit != null ? result.slice(0, filter.limit) : result
    } catch (err) {
      throw new ProviderError('instabox', err)
    }
  }

  async destroySandbox(id: string): Promise<void> {
    const client = await this.getClient()
    try {
      await waitForOperation(client, await client.deleteMachine(id))
    } catch (err) {
      // Idempotent: already destroyed
      if (err instanceof InstaBoxApiError && err.status === 404) return

      // 409: another operation is in flight — wait for it, then retry once
      if (err instanceof InstaBoxApiError && err.status === 409 && err.operationId) {
        await waitForOperation(client, await client.getOperation(err.operationId, OP_POLL_SECONDS))
        try {
          await waitForOperation(client, await client.deleteMachine(id))
          return
        } catch (retryErr) {
          if (retryErr instanceof InstaBoxApiError && retryErr.status === 404) return
          throw new ProviderError('instabox', retryErr, id)
        }
      }

      if (err instanceof ProviderError) throw err
      throw new ProviderError('instabox', err, id)
    }
  }
}
