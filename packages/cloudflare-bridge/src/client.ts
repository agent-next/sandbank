import type {
  AdapterSandbox,
  Capability,
  CreateConfig,
  ExecOptions,
  ExecResult,
  ListFilter,
  SandboxAdapter,
  SandboxInfo,
} from '@sandbank.dev/core'
import { ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'
import type { BridgeSandboxInfo } from './protocol.js'

export interface CloudflareBridgeConfig {
  /** Bridge Worker base URL, e.g. https://sandbank-cloudflare-bridge.<subdomain>.workers.dev */
  url: string
  /** Bearer token the bridge was deployed with. */
  token: string
  fetch?: typeof fetch
}

const PROVIDER = 'cloudflare'

/** Sandbank adapter that drives Cloudflare Sandboxes through the bridge Worker over HTTP. */
export class CloudflareBridgeAdapter implements SandboxAdapter {
  readonly name = PROVIDER
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['port.expose'])

  private readonly base: string
  private readonly token: string
  private readonly doFetch: typeof fetch

  constructor(config: CloudflareBridgeConfig) {
    this.base = config.url.replace(/\/+$/, '')
    this.token = config.token
    this.doFetch = config.fetch ?? fetch
  }

  private async call<T>(method: string, path: string, body?: unknown, id?: string, idempotent = false): Promise<T> {
    const send = () =>
      this.doFetch(`${this.base}/v1/sandboxes${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    let res: Response
    try {
      // A stale keep-alive socket fails the first attempt; safe to retry once only for idempotent calls.
      res = await send().catch((err) => (idempotent ? send() : Promise.reject(err)))
    } catch (err) {
      throw new ProviderError(PROVIDER, err, id)
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.status === 404 && id) throw new SandboxNotFoundError(PROVIDER, id)
    if (!res.ok) throw new ProviderError(PROVIDER, new Error(`bridge ${res.status}: ${data.error ?? res.statusText}`), id)
    return data as T
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const info = await this.call<BridgeSandboxInfo>('POST', '', {
      env: config.env,
      lifetimeMinutes: config.autoDestroyMinutes,
    })
    return this.wrap(info)
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    return this.wrap(await this.call<BridgeSandboxInfo>('GET', `/${encodeURIComponent(id)}`, undefined, id, true))
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    const { sandboxes } = await this.call<{ sandboxes: BridgeSandboxInfo[] }>('GET', '', undefined, undefined, true)
    let infos: SandboxInfo[] = sandboxes.map((s) => ({ id: s.id, state: s.state, createdAt: s.createdAt, image: '' }))
    if (filter?.state) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state]
      infos = infos.filter((s) => states.includes(s.state))
    }
    return filter?.limit && filter.limit > 0 ? infos.slice(0, filter.limit) : infos
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/${encodeURIComponent(id)}`, undefined, id, true)
    } catch (err) {
      if (!(err instanceof SandboxNotFoundError)) throw err
    }
  }

  private wrap(info: BridgeSandboxInfo): AdapterSandbox {
    const id = info.id
    const p = `/${encodeURIComponent(id)}`
    return {
      id,
      state: info.state,
      createdAt: info.createdAt,
      exec: (command: string, options?: ExecOptions) =>
        this.call<ExecResult>('POST', `${p}/exec`, { command, cwd: options?.cwd, timeoutMs: options?.timeout }, id),
      writeFile: async (path: string, content: string | Uint8Array) => {
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
        await this.call('POST', `${p}/files/write`, { path, contentBase64: Buffer.from(bytes).toString('base64') }, id)
      },
      readFile: async (path: string) => {
        const { contentBase64 } = await this.call<{ contentBase64: string }>('POST', `${p}/files/read`, { path }, id, true)
        return new Uint8Array(Buffer.from(contentBase64, 'base64'))
      },
      exposePort: (port: number) => this.call<{ url: string }>('POST', `${p}/ports`, { port }, id),
    }
  }
}
