import { createProvider } from '@sandbank.dev/core'
import type { SandboxProvider } from '@sandbank.dev/core'
import { DockerAdapter } from '@sandbank.dev/docker'
import { SbxAdapter } from '@sandbank.dev/sbx'

export interface ProviderEntry {
  configured: boolean
  /** Lazily builds (and caches) the provider. */
  get(): SandboxProvider
}

export type ProviderRegistry = Record<string, ProviderEntry>

function lazy(configured: boolean, make: () => SandboxProvider): ProviderEntry {
  let provider: SandboxProvider | undefined
  return { configured, get: () => (provider ??= make()) }
}

/** Set and not an unexpanded `${VAR}` placeholder from a plugin config. */
const isSet = (v?: string) => Boolean(v) && !v!.startsWith('${')

export function defaultRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const all: ProviderRegistry = {
    docker: lazy(true, () => createProvider(new DockerAdapter())),
    sbx: lazy(isSet(env.SBX_API_KEY) || isSet(env.E2B_API_KEY), () => createProvider(new SbxAdapter())),
  }
  // SANDBANK_MCP_PROVIDERS=sbx limits what the server exposes (e.g. hide docker on a hosted server).
  const only = env.SANDBANK_MCP_PROVIDERS?.split(',').map((s) => s.trim()).filter(Boolean)
  return only ? Object.fromEntries(Object.entries(all).filter(([name]) => only.includes(name))) : all
}
