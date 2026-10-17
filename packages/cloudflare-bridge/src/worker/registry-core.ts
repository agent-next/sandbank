import { DEFAULT_LIFETIME_MIN, MAX_LIFETIME_MIN, MAX_SANDBOXES } from './limits.js'

export interface SandboxEntry {
  id: string
  createdAt: number
  expiresAt: number
}

export interface EntryStore {
  read(): Promise<SandboxEntry[]>
  write(entries: SandboxEntry[]): Promise<void>
}

export type ReserveResult = { ok: true; entry: SandboxEntry } | { ok: false; reason: 'capacity'; max: number }

export function clampLifetimeMin(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_LIFETIME_MIN
  return Math.min(v, MAX_LIFETIME_MIN)
}

/** Concurrent-sandbox cap and lifetime bookkeeping. Holds no alarms. */
export class RegistryCore {
  constructor(
    private readonly store: EntryStore,
    private readonly max = MAX_SANDBOXES,
  ) {}

  async reserve(id: string, lifetimeMin: number, now: number): Promise<ReserveResult> {
    const entries = await this.store.read()
    const max = Math.min(this.max, MAX_SANDBOXES)
    if (entries.length >= max) return { ok: false, reason: 'capacity', max }
    const entry = { id, createdAt: now, expiresAt: now + clampLifetimeMin(lifetimeMin) * 60_000 }
    await this.store.write([...entries, entry])
    return { ok: true, entry }
  }

  list(): Promise<SandboxEntry[]> {
    return this.store.read()
  }

  /** Move an entry's expiry (the reaper destroys it then); no-op for an unknown id. */
  async expire(id: string, at: number): Promise<void> {
    const entries = await this.store.read()
    await this.store.write(entries.map((e) => (e.id === id ? { ...e, expiresAt: at } : e)))
  }

  async release(id: string): Promise<void> {
    const entries = await this.store.read()
    await this.store.write(entries.filter((e) => e.id !== id))
  }
}
