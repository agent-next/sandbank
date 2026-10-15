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

export function defaultRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  return {
    docker: lazy(true, () => createProvider(new DockerAdapter())),
    sbx: lazy(Boolean(env.SBX_API_KEY || env.E2B_API_KEY), () => createProvider(new SbxAdapter())),
  }
}
