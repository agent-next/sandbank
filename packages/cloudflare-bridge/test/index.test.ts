import { beforeEach, describe, expect, it, vi } from 'vitest'

const sandboxes = new Map<string, Record<string, ReturnType<typeof vi.fn>>>()
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: (_ns: unknown, id: string) => {
    if (!sandboxes.has(id)) {
      sandboxes.set(id, {
        destroy: vi.fn(async () => {}),
        setEnvVars: vi.fn(async () => {}),
        exec: vi.fn(async () => ({ success: true, stdout: 'o', stderr: '' })),
        readFile: vi.fn(async () => ({ content: 'aGk=' })),
        writeFile: vi.fn(async () => {}),
        exposePort: vi.fn(async () => ({ url: 'https://p' })),
      })
    }
    return sandboxes.get(id)
  },
}))
vi.mock('../src/worker/guarded-sandbox.js', () => ({ Sandbox: class {} }))
vi.mock('../src/worker/registry-do.js', () => ({ SandboxRegistry: class {} }))

const { default: worker } = await import('../src/worker/index.js')

function env(extra: Record<string, string> = {}) {
  let entries: { id: string; createdAt: number; expiresAt: number }[] = []
  const reg = {
    reserve: async (id: string, min: number, now: number) => {
      const entry = { id, createdAt: now, expiresAt: now + min * 60_000 }
      entries = [...entries, entry]
      return { ok: true, entry }
    },
    list: async () => entries,
    release: async (id: string) => void (entries = entries.filter((e) => e.id !== id)),
  }
  return {
    entries: () => entries,
    seed: (e: typeof entries) => void (entries = e),
    env: { BRIDGE_TOKEN: 't', Sandbox: {}, REGISTRY: { idFromName: () => 'id', get: () => reg }, ...extra } as never,
  }
}

const call = (e: never, method: string, path: string, body?: unknown) =>
  worker.fetch(
    new Request(`https://b.test${path}`, { method, headers: { authorization: 'Bearer t' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    e,
  )

beforeEach(() => sandboxes.clear())

describe('worker entry wiring', () => {
  it('maps the bridge API onto the Sandbox SDK', async () => {
    const { env: e } = env()
    const created = (await (await call(e, 'POST', '/v1/sandboxes', { env: { A: '1' } })).json()) as { id: string }
    const sb = sandboxes.get(created.id)!
    expect(sb.setEnvVars).toHaveBeenCalledWith({ A: '1' })
    expect(await (await call(e, 'POST', `/v1/sandboxes/${created.id}/exec`, { command: 'ls' })).json()).toEqual({ exitCode: 0, stdout: 'o', stderr: '' })
    expect(await (await call(e, 'POST', `/v1/sandboxes/${created.id}/files/read`, { path: '/a' })).json()).toEqual({ contentBase64: 'aGk=' })
    expect(sb.readFile).toHaveBeenCalledWith('/a', { encoding: 'base64' })
    await call(e, 'POST', `/v1/sandboxes/${created.id}/files/write`, { path: '/a', contentBase64: 'aGk=' })
    expect(sb.writeFile).toHaveBeenCalledWith('/a', 'aGk=', { encoding: 'base64' })
    await call(e, 'DELETE', `/v1/sandboxes/${created.id}`)
    expect(sb.destroy).toHaveBeenCalled()
  })
})

describe('scheduled (cron)', () => {
  const seed = (s: ReturnType<typeof env>) => s.seed([
    { id: 'old', createdAt: 0, expiresAt: 1 },
    { id: 'fresh', createdAt: 0, expiresAt: Date.now() + 3_600_000 },
  ])
  it('destroys only expired sandboxes when not draining', async () => {
    const s = env(); seed(s)
    await worker.scheduled({} as never, s.env)
    expect(s.entries().map((e) => e.id)).toEqual(['fresh'])
    expect(sandboxes.get('old')!.destroy).toHaveBeenCalled()
    expect(sandboxes.has('fresh')).toBe(false)
  })
  it('destroys every sandbox when DRAIN=1', async () => {
    const s = env({ DRAIN: '1' }); seed(s)
    await worker.scheduled({} as never, s.env)
    expect(s.entries()).toEqual([])
    expect(sandboxes.get('fresh')!.destroy).toHaveBeenCalled()
  })
  it('fetch returns 503 when DRAIN=1', async () => {
    expect((await call(env({ DRAIN: '1' }).env, 'GET', '/v1/sandboxes')).status).toBe(503)
  })
})
