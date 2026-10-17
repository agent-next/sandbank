import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { clampSchedule, guardedAlarm, isDrain } from '../src/worker/alarm-guard.js'
import { safeEqual } from '../src/worker/auth.js'
import { RegistryCore, type SandboxEntry } from '../src/worker/registry-core.js'
import { MAX_ALARM_HORIZON_S, MAX_LIFETIME_MIN, MAX_SANDBOXES } from '../src/worker/limits.js'

const wrangler = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))

describe('container config (safety 1)', () => {
  const c = wrangler.containers[0]
  it('caps instances at MAX_SANDBOXES', () => expect(c.max_instances).toBeLessThanOrEqual(MAX_SANDBOXES))
  it('uses the smallest instance type that fits a Claude Code worker', () => expect(c.instance_type).toBe('standard-1'))
  it('sleeps after <= 5 minutes', async () => {
    vi.doMock('@cloudflare/sandbox', () => ({
      Sandbox: class {
        env = {}
        ctx = { storage: { deleteAlarm: async () => {} } }
        async schedule() {}
        async alarm() {}
        async destroy() {}
      },
    }))
    const { Sandbox } = await import('../src/worker/guarded-sandbox.js')
    const sleepAfter = new (Sandbox as never as new () => { sleepAfter: string })().sleepAfter
    expect(sleepAfter).toBe('5m')
    expect(parseInt(sleepAfter, 10)).toBeLessThanOrEqual(5)
  })
  it('has a cron trigger for the lifetime reaper', () => expect(wrangler.triggers.crons.length).toBeGreaterThan(0))
  it('defaults DRAIN off in vars but declares it', () => expect(wrangler.vars.DRAIN).toBe('0'))
})

describe('lifetime and cap (safety 1, 4)', () => {
  const mem = () => {
    let e: SandboxEntry[] = []
    return { read: async () => e, write: async (n: SandboxEntry[]) => void (e = n) }
  }
  it('defaults to 30 min and clamps to 60', async () => {
    const r = new RegistryCore(mem())
    const a = await r.reserve('a', NaN, 0)
    const b = await r.reserve('b', 10_000, 0)
    expect(a.ok && a.entry.expiresAt).toBe(30 * 60_000)
    expect(b.ok && b.entry.expiresAt).toBe(MAX_LIFETIME_MIN * 60_000)
  })
  it('refuses the sandbox past the cap and frees a slot on release', async () => {
    const r = new RegistryCore(mem())
    for (let i = 0; i < MAX_SANDBOXES; i++) expect((await r.reserve(`s${i}`, 5, 0)).ok).toBe(true)
    expect(await r.reserve('x', 5, 0)).toEqual({ ok: false, reason: 'capacity', max: MAX_SANDBOXES })
    await r.release('s0')
    expect((await r.reserve('x', 5, 0)).ok).toBe(true)
  })
  it('cannot be configured above MAX_SANDBOXES', async () => {
    const r = new RegistryCore(mem(), MAX_SANDBOXES + 50)
    for (let i = 0; i < MAX_SANDBOXES; i++) await r.reserve(`s${i}`, 5, 0)
    expect((await r.reserve('x', 5, 0)).ok).toBe(false)
  })
})

describe('kill switch (safety 2)', () => {
  it('reads DRAIN=1/true only', () => {
    expect(isDrain({ DRAIN: '1' })).toBe(true)
    expect(isDrain({ DRAIN: 'true' })).toBe(true)
    expect(isDrain({ DRAIN: '0' })).toBe(false)
    expect(isDrain({})).toBe(false)
  })
  it('alarm under DRAIN deletes the alarm, stops the container and does not run the real alarm', async () => {
    const deleteAlarm = vi.fn(async () => {})
    const run = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    await guardedAlarm({ drain: true, deleteAlarm, run, stop })
    expect(deleteAlarm).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('alarm hygiene (safety 3)', () => {
  const now = 1_800_000_000_000
  it('treats a number as SECONDS: epoch milliseconds are clamped, not scheduled for year 2189+', () => {
    // The postmortem bug: schedule(Date.now() + interval) passed epoch ms where seconds are expected.
    expect(clampSchedule(now + 30_000, now)).toBe(MAX_ALARM_HORIZON_S)
    expect(clampSchedule(now, now)).toBe(MAX_ALARM_HORIZON_S)
  })
  it('keeps sane second delays', () => expect(clampSchedule(30, now)).toBe(30))
  it('clamps NaN, Infinity and negatives', () => {
    expect(clampSchedule(NaN, now)).toBe(MAX_ALARM_HORIZON_S)
    expect(clampSchedule(Infinity, now)).toBe(MAX_ALARM_HORIZON_S)
    expect(clampSchedule(-5, now)).toBe(0)
  })
  it('clamps Dates beyond now+1h, in the past, and invalid', () => {
    const far = clampSchedule(new Date(now + 10 * 365 * 86_400_000), now) as Date
    expect(far.getTime()).toBe(now + 3_600_000)
    expect((clampSchedule(new Date(now - 5000), now) as Date).getTime()).toBe(now)
    expect((clampSchedule(new Date(NaN), now) as Date).getTime()).toBe(now + 3_600_000)
  })
  it('alarm never throws out: failure stops the container and parks (deletes) the alarm', async () => {
    const deleteAlarm = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    const log = vi.fn()
    await expect(
      guardedAlarm({ drain: false, deleteAlarm, stop, log, run: async () => { throw new TypeError("This API doesn't support dates after 2189") } }),
    ).resolves.toBeUndefined()
    expect(deleteAlarm).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalled()
  })
  it('alarm survives a failing cleanup', async () => {
    await expect(
      guardedAlarm({
        drain: false,
        run: async () => { throw new Error('x') },
        stop: async () => { throw new Error('y') },
        deleteAlarm: async () => { throw new Error('z') },
      }),
    ).resolves.toBeUndefined()
  })
  it('the Sandbox DO wires schedule() and alarm() through the guards', async () => {
    const calls: unknown[] = []
    vi.resetModules()
    vi.doMock('@cloudflare/sandbox', () => ({
      Sandbox: class {
        env: { DRAIN?: string } = {}
        ctx = { storage: { deleteAlarm: async () => void calls.push('deleteAlarm') } }
        async schedule(when: unknown) { calls.push(['schedule', when]) }
        async alarm() { calls.push('realAlarm') }
        async destroy() { calls.push('destroy') }
      },
    }))
    const { Sandbox } = await import('../src/worker/guarded-sandbox.js')
    const sb = new (Sandbox as never as new () => { env: { DRAIN?: string }; schedule(w: number, c: string): Promise<void>; alarm(p: object): Promise<void> })()
    await sb.schedule(Date.now() + 5000, 'cb')
    expect(calls.pop()).toEqual(['schedule', MAX_ALARM_HORIZON_S])
    await sb.alarm({ isRetry: false, retryCount: 0 })
    expect(calls).toEqual(['realAlarm'])
    calls.length = 0
    sb.env.DRAIN = '1'
    await sb.alarm({ isRetry: false, retryCount: 0 })
    expect(calls).toEqual(['destroy', 'deleteAlarm'])
  })
})

describe('constant-time compare', () => {
  it('matches equal and rejects different/length-mismatched strings', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true)
    expect(await safeEqual('abc', 'abd')).toBe(false)
    expect(await safeEqual('abc', 'abcd')).toBe(false)
    expect(await safeEqual('', 'x')).toBe(false)
  })
})
