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

// exec runs through `bash -lc` with a 60 s default / 600 s max per the API.
const DEFAULT_EXEC_TIMEOUT_SECONDS = 60
const MAX_EXEC_TIMEOUT_SECONDS = 600

// Lifecycle ops are long-polled (?wait=25s, server caps at 30s); bounded to ~25 min.
const OP_POLL_SECONDS = 25
const OP_MAX_ATTEMPTS = 60


// Chunk size for chunked base64 reads (raw bytes per exec; base64 ~1.33x < 1 MiB stdout cap).
const READ_CHUNK_BYTES = 524288
// Chunk size for chunked base64 writes (raw bytes per exec; base64 ~1.33x < 1 MiB stdin cap).
const WRITE_CHUNK_BYTES = 524288

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

function toExecTimeoutSeconds(ms?: number): number {
  if (ms == null) return DEFAULT_EXEC_TIMEOUT_SECONDS
  return Math.min(MAX_EXEC_TIMEOUT_SECONDS, Math.max(1, Math.round(ms / 1000)))
}

/** Machine name: 1-63 of a-z, 0-9, '-'. */
function generateName(): string {
  return `sb-${crypto.randomUUID().slice(0, 8)}`
}

/** Snapshot name: 1-63 of a-z, 0-9, '-', starting with a letter or digit. */

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

/** Wait for an operation to reach ANY terminal state (succeeded or failed). */
async function waitForTerminalOperation(client: InstaBoxClient, op: InstaBoxOperation): Promise<InstaBoxOperation> {
  for (let i = 0; i < OP_MAX_ATTEMPTS; i++) {
    if (op.state === 'succeeded' || op.state === 'failed') return op
    op = await client.getOperation(op.id, OP_POLL_SECONDS)
  }
  throw new ProviderError('instabox', new Error(`Timed out waiting for operation ${op.id}`), op.machineId)
}

/** Wrap machine data + client into an AdapterSandbox. `env` is replayed on every exec. */
function wrapSandbox(
  client: InstaBoxClient,
  data: InstaBoxMachine,
  env: Record<string, string> | undefined,
): AdapterSandbox {
  // Commands run as root, like the other providers (the guest user has passwordless sudo):
  // sudo -n -E bash -lc <quoted cmd>. The files endpoint reads as root too.
  const wrapCmd = (command: string): string => `sudo -n -E bash -lc ${shellQuote(command)}`

  return {
    get id() { return data.id },
    get state() { return mapState(data.state) },
    get createdAt() { return data.createdAt },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const cmd = wrapCmd(command)
      const result = await client.exec(data.id, {
        cmd,
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
      // exec stdin caps at 1 MiB: send base64 chunks, the first truncates, the rest append.
      let off = 0
      do {
        const chunk = bytes.subarray(off, off + WRITE_CHUNK_BYTES)
        // Quote the substitution output too: mkdir -p "$(dirname '<path>')"
        const cmd = off === 0
          ? `mkdir -p "$(dirname ${shellQuote(path)})" && base64 -d > ${shellQuote(path)}`
          : `base64 -d >> ${shellQuote(path)}`
        const result = await client.exec(data.id, {
          cmd: wrapCmd(cmd),
          stdin: toBase64(chunk),
          envs: env,
        })
        if (result.exitCode !== 0) {
          throw new Error(`writeFile failed for '${path}': ${result.stderr || `exit ${result.exitCode}`}`)
        }
        off += WRITE_CHUNK_BYTES
      } while (off < bytes.length)
    },

    async readFile(path: string): Promise<Uint8Array> {
      const file = await client.readFile(data.id, path)
      if (file.type === 'file' && !file.binary && !file.truncated && file.content != null) {
        return new TextEncoder().encode(file.content)
      }
      // Binary or oversized file — chunked base64 through exec (stdout caps at 1 MiB).
      const chunks: Uint8Array[] = []
      let skip = 0
      for (;;) {
        const cmd = `set -o pipefail; dd if=${shellQuote(path)} bs=${READ_CHUNK_BYTES} skip=${skip} count=1 status=none | base64 -w0`
        const result = await client.exec(data.id, { cmd: wrapCmd(cmd), envs: env })
        if (result.exitCode !== 0) {
          throw new Error(`readFile failed for '${path}': ${result.stderr || `exit ${result.exitCode}`}`)
        }
        if (result.truncated) {
          throw new ProviderError('instabox', new Error(`readFile truncated for '${path}'`), data.id)
        }
        const raw = fromBase64(result.stdout.replace(/\s/g, ''))
        if (raw.length === 0) break
        chunks.push(raw)
        if (raw.length < READ_CHUNK_BYTES) break
        skip += 1
      }
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.length }
      return out
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
  }
}

export class InstaBoxAdapter implements SandboxAdapter {
  readonly name = 'instabox'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'sleep',
    'port.expose',
  ])

  private clientPromise: Promise<InstaBoxClient> | null = null
  private readonly config: InstaBoxAdapterConfig
  private readonly envBySandbox = new Map<string, Record<string, string>>()

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
        metadata: METADATA_LABEL,
        vault: false,
      }
      // autoDestroyMinutes: 0 or omitted => no auto-destroy (omit timeoutSeconds/onTimeout).
      if (config.autoDestroyMinutes && config.autoDestroyMinutes > 0) {
        const seconds = config.autoDestroyMinutes * 60
        const clamped = Math.min(14400, Math.max(60, seconds))
        body.timeoutSeconds = clamped
        body.onTimeout = 'kill'
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
      const sandbox = wrapSandbox(client, machine, config.env)
      if (config.env) this.envBySandbox.set(machine.id, config.env)
      return sandbox
    } catch (err) {
      if (err instanceof ProviderError) throw err
      throw new ProviderError('instabox', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const client = await this.getClient()
    try {
      const machine = await client.getMachine(id)
      const env = this.envBySandbox.get(id)
      return wrapSandbox(client, machine, env)
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
            image: machine.snapshot?.id ?? machine.template?.id ?? machine.name,
          })
        }
        cursor = page.nextCursor ?? undefined
        // Apply state filter before counting toward limit
        if (filter?.state) {
          const states = Array.isArray(filter.state) ? filter.state : [filter.state]
          const filtered = infos.filter((s) => states.includes(s.state))
          if (filter.limit != null && filtered.length >= filter.limit) break
        } else if (filter?.limit != null && infos.length >= filter.limit) {
          break
        }
      } while (cursor)

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

      // 409: another operation is in flight — wait for it to reach ANY terminal state, then retry once
      if (err instanceof InstaBoxApiError && err.status === 409 && err.operationId) {
        await waitForTerminalOperation(client, await client.getOperation(err.operationId, OP_POLL_SECONDS))
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
