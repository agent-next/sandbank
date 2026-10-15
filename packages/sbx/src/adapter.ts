import type {
  AdapterSandbox,
  Capability,
  CreateConfig,
  ListFilter,
  SandboxAdapter,
  SandboxInfo,
} from '@sandbank.dev/core'
import { ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'
import { E2BAdapter } from '@sandbank.dev/e2b'
import type { SbxAdapterConfig } from './types.js'

const DEFAULT_DOMAIN = 'sbx.agent-next.com'
const DEFAULT_AUTO_DESTROY_MINUTES = 60

/** Re-label errors from the E2B protocol layer with this provider's name. */
function relabel(err: unknown, id?: string): never {
  if (err instanceof SandboxNotFoundError) throw new SandboxNotFoundError('sbx', err.sandboxId ?? id ?? '')
  if (err instanceof ProviderError) throw new ProviderError('sbx', err.cause, err.sandboxId ?? id)
  throw err
}

/**
 * agent-next sandbox (sbx) adapter.
 *
 * sbx speaks the E2B API, so this adapter drives it through the E2B SDK with
 * sbx endpoints and defaults. Volumes are not offered: sbx has no E2B volume API.
 */
export class SbxAdapter implements SandboxAdapter {
  readonly name = 'sbx'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'terminal',
    'sleep',
    'port.expose',
  ])

  private readonly inner: E2BAdapter
  private readonly autoDestroyMinutes: number

  constructor(config: SbxAdapterConfig = {}) {
    const domain = config.domain ?? process.env.SBX_DOMAIN ?? DEFAULT_DOMAIN
    this.inner = new E2BAdapter({
      apiKey: config.apiKey ?? process.env.SBX_API_KEY ?? process.env.E2B_API_KEY,
      domain,
      apiUrl: config.apiUrl ?? `https://api.${domain}`,
      requestTimeoutMs: config.requestTimeoutMs,
      template: config.template,
    })
    this.autoDestroyMinutes = config.autoDestroyMinutes ?? DEFAULT_AUTO_DESTROY_MINUTES
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    try {
      return await this.inner.createSandbox({
        ...config,
        autoDestroyMinutes: config.autoDestroyMinutes ?? this.autoDestroyMinutes,
      })
    } catch (err) {
      relabel(err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    try {
      return await this.inner.getSandbox(id)
    } catch (err) {
      relabel(err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    try {
      return await this.inner.listSandboxes(filter)
    } catch (err) {
      relabel(err)
    }
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.inner.destroySandbox(id)
    } catch (err) {
      relabel(err, id)
    }
  }
}
