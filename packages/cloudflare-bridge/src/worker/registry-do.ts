import { DurableObject } from 'cloudflare:workers'
import type { DrainEnv } from './alarm-guard.js'
import { RegistryCore, type ReserveResult, type SandboxEntry } from './registry-core.js'

const KEY = 'entries'

/** Single-instance bookkeeping for the concurrent-sandbox cap and lifetimes. */
export class SandboxRegistry extends DurableObject<DrainEnv> {
  private core = new RegistryCore({
    read: async () => (await this.ctx.storage.get<SandboxEntry[]>(KEY)) ?? [],
    write: async (entries) => {
      await this.ctx.storage.put(KEY, entries)
    },
  })

  reserve(id: string, lifetimeMin: number, now: number): Promise<ReserveResult> {
    return this.core.reserve(id, lifetimeMin, now)
  }

  list(): Promise<SandboxEntry[]> {
    return this.core.list()
  }

  expire(id: string, at: number): Promise<void> {
    return this.core.expire(id, at)
  }

  release(id: string): Promise<void> {
    return this.core.release(id)
  }

  // This object never schedules alarms; any stray alarm is removed.
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
  }
}
