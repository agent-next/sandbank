import { describe, expect, it, vi } from 'vitest'
import { handle, reap, type Backend, type BridgeDeps } from '../src/worker/handler.js'
import { RegistryCore, type SandboxEntry } from '../src/worker/registry-core.js'
import { CREATE_TIMEOUT_MS, DESTROY_TIMEOUT_MS, MAX_SANDBOXES, PROVISIONING_REAP_MS } from '../src/worker/limits.js'

function setup(env: BridgeDeps['env'] = { BRIDGE_TOKEN: 'secret' }) {
  let entries: SandboxEntry[] = []
  const core = new RegistryCore({ read: async () => entries, write: async (e) => void (entries = e) })
  let t = 1_000_000
  let n = 0
  const backend = {
    create: vi.fn(async () => {}),
    exec: vi.fn(async (_id: string, command: string) => ({ exitCode: 0, stdout: `ran:${command}`, stderr: '' })),
    readFile: vi.fn(async () => 'aGk='),
    writeFile: vi.fn(async () => {}),
    exposePort: vi.fn(async () => ({ url: 'https://x' })),
    destroy: vi.fn(async () => {}),
  } satisfies Backend
  const deps: BridgeDeps = { env, registry: core, backend, now: () => t, newId: () => `cf-${++n}` }
  const req = (method: string, path: string, body?: unknown, token: string | null = 'secret') =>
    handle(
      new Request(`https://bridge.test${path}`, {
        method,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      deps,
    )
  return { deps, backend, req, advance: (ms: number) => void (t += ms), entries: () => entries }
}

describe('auth (safety 4)', () => {
  it('rejects missing, wrong and malformed tokens before touching anything', async () => {
    const s = setup()
    for (const token of [null, 'nope', '']) expect((await s.req('POST', '/v1/sandboxes', {}, token)).status).toBe(401)
    expect(s.backend.create).not.toHaveBeenCalled()
    expect(s.entries()).toEqual([])
  })
  it('fails closed when no token is configured', async () => {
    const s = setup({})
    expect((await s.req('GET', '/v1/sandboxes', undefined, 'anything')).status).toBe(401)
  })
})

describe('DRAIN (safety 2)', () => {
  it('returns 503 for every request, even authorized ones, and does nothing', async () => {
    const s = setup({ BRIDGE_TOKEN: 'secret', DRAIN: '1' })
    expect((await s.req('POST', '/v1/sandboxes', {})).status).toBe(503)
    expect((await s.req('GET', '/v1/sandboxes')).status).toBe(503)
    expect(s.backend.create).not.toHaveBeenCalled()
  })
  it('cron reap with all=true destroys every sandbox', async () => {
    const s = setup()
    await s.req('POST', '/v1/sandboxes', {})
    await s.req('POST', '/v1/sandboxes', {})
    expect(await reap(s.deps, true)).toEqual(['cf-1', 'cf-2'])
    expect(s.entries()).toEqual([])
    expect(s.backend.destroy).toHaveBeenCalledTimes(2)
  })
})

describe('cap and lifetime (safety 1, 4)', () => {
  it('returns a clear 429 at the cap', async () => {
    const s = setup()
    for (let i = 0; i < MAX_SANDBOXES; i++) expect((await s.req('POST', '/v1/sandboxes', {})).status).toBe(201)
    const r = await s.req('POST', '/v1/sandboxes', {})
    expect(r.status).toBe(429)
    expect(await r.json()).toMatchObject({ code: 'capacity', error: expect.stringContaining(`cap reached (${MAX_SANDBOXES} concurrent)`) })
    expect(s.backend.create).toHaveBeenCalledTimes(MAX_SANDBOXES)
  })
  it('a failed create releases its slot', async () => {
    const s = setup()
    s.backend.create.mockRejectedValueOnce(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await s.req('POST', '/v1/sandboxes', {})
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: 'internal error' })
    expect(s.entries()).toEqual([])
  })
  it('a container that does not start in time answers 503 provisioning and is reaped later, never orphaned', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      let start!: () => void
      s.backend.create.mockImplementationOnce(() => new Promise<void>((res) => (start = res)))
      const pending = s.req('POST', '/v1/sandboxes', {})
      // the handler awaits the registry before it arms the timer, so advance in steps
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS / 2)
      const r = await pending
      expect(r.status).toBe(503)
      expect(r.headers.get('retry-after')).toBe('30')
      expect(await r.json()).toMatchObject({ code: 'provisioning' })
      // the slot stays held (the container may still come up) with a short expiry, and nothing is destroyed yet
      expect(s.entries()).toEqual([expect.objectContaining({ id: 'cf-1', expiresAt: 1_000_000 + PROVISIONING_REAP_MS })])
      expect(s.backend.destroy).not.toHaveBeenCalled()
      start() // the late container comes up
      s.advance(PROVISIONING_REAP_MS + 1)
      expect((await s.req('GET', '/v1/sandboxes')).status).toBe(200) // any request reaps
      expect(s.backend.destroy).toHaveBeenCalledWith('cf-1')
      expect(s.entries()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  it('a create that fails after the provisioning timeout is logged, not an unhandled rejection', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = setup()
      let fail!: (e: Error) => void
      s.backend.create.mockImplementationOnce(() => new Promise<void>((_, rej) => (fail = rej)))
      const pending = s.req('POST', '/v1/sandboxes', {})
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS / 2)
      expect((await pending).status).toBe(503)
      fail(new Error('start failed'))
      await vi.advanceTimersByTimeAsync(1)
      expect(log).toHaveBeenCalledWith('create cf-1 failed after the provisioning timeout', expect.any(Error))
    } finally {
      log.mockRestore()
      vi.useRealTimers()
    }
  })
  it('a create that starts in time clears its timer', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      expect((await s.req('POST', '/v1/sandboxes', {})).status).toBe(201)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('destroys expired sandboxes on access (410) and frees the slot', async () => {
    const s = setup()
    await s.req('POST', '/v1/sandboxes', { lifetimeMinutes: 5 })
    s.advance(5 * 60_000 + 1)
    const r = await s.req('POST', '/v1/sandboxes/cf-1/exec', { command: 'ls' })
    expect(r.status).toBe(410)
    expect(s.backend.destroy).toHaveBeenCalledWith('cf-1')
    expect(s.backend.exec).not.toHaveBeenCalled()
    expect(s.entries()).toEqual([])
  })
  it('a destroy that never returns does not block create or list (reap is bounded)', async () => {
    // 2026-10-17: one wedged sandbox DO made every create and list hang for minutes, because each
    // request reaps inline and waited on that destroy
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = setup()
      await s.req('POST', '/v1/sandboxes', { lifetimeMinutes: 1 })
      s.advance(61_000)
      s.backend.destroy.mockImplementation(() => new Promise<void>(() => {}))
      // timers register after the async auth check, whose real duration varies with load: keep
      // stepping the fake clock until the request answers (a hang fails at the test timeout)
      const answer = async (r: Promise<Response>) => {
        let res: Response | undefined
        void r.then((x) => (res = x))
        while (!res) await vi.advanceTimersByTimeAsync(DESTROY_TIMEOUT_MS / 5)
        return res
      }
      expect((await answer(s.req('POST', '/v1/sandboxes', {}))).status).toBe(201)
      expect((await answer(s.req('GET', '/v1/sandboxes'))).status).toBe(200)
      // the wedged one stays registered (counted against the cap, retried by the next reap): never orphaned
      expect(s.entries().map((e) => e.id)).toEqual(['cf-1', 'cf-2'])
      expect(log).toHaveBeenCalledWith('destroy cf-1 did not finish; kept for the next reap')
    } finally {
      log.mockRestore()
      vi.useRealTimers()
    }
  })
  it('reaps expired sandboxes before enforcing the cap on create', async () => {
    const s = setup()
    for (let i = 0; i < MAX_SANDBOXES; i++) await s.req('POST', '/v1/sandboxes', { lifetimeMinutes: 1 })
    s.advance(61_000)
    expect((await s.req('POST', '/v1/sandboxes', {})).status).toBe(201)
  })
  it('caps lifetime at 60 minutes', async () => {
    const s = setup()
    const r = await (await s.req('POST', '/v1/sandboxes', { lifetimeMinutes: 100000 })).json()
    expect(Date.parse(r.expiresAt) - Date.parse(r.createdAt)).toBe(60 * 60_000)
  })
  it('never forwards an unregistered id to the backend', async () => {
    const s = setup()
    expect((await s.req('POST', '/v1/sandboxes/cf-evil/exec', { command: 'id' })).status).toBe(404)
    expect(s.backend.exec).not.toHaveBeenCalled()
  })
  it('caps exec timeout', async () => {
    const s = setup()
    await s.req('POST', '/v1/sandboxes', {})
    await s.req('POST', '/v1/sandboxes/cf-1/exec', { command: 'x', timeoutMs: 9e9 })
    expect(s.backend.exec).toHaveBeenCalledWith('cf-1', 'x', { cwd: undefined, timeoutMs: 300_000 })
  })
})

describe('credit-end deadline', () => {
  it('refuses create at or after the deadline but still serves existing sandboxes', async () => {
    const s = setup({ BRIDGE_TOKEN: 'secret', CREATE_DEADLINE: new Date(1_000_000 + 1000).toISOString() })
    expect((await s.req('POST', '/v1/sandboxes', {})).status).toBe(201)
    s.advance(1000)
    const r = await s.req('POST', '/v1/sandboxes', {})
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ code: 'deadline' })
    expect((await s.req('GET', '/v1/sandboxes/cf-1')).status).toBe(200)
  })
  it('has no deadline unless one is configured', async () => {
    const s = setup()
    s.advance(10 * 365 * 86_400_000)
    expect((await s.req('POST', '/v1/sandboxes', {})).status).toBe(201)
  })
  it('fails closed on an unparseable deadline', async () => {
    const s = setup({ BRIDGE_TOKEN: 'secret', CREATE_DEADLINE: 'garbage' })
    expect((await s.req('POST', '/v1/sandboxes', {})).status).toBe(403)
  })
})

describe('body cap', () => {
  it('rejects a declared oversized body before reading it', async () => {
    const s = setup()
    const r = await handle(
      new Request('https://bridge.test/v1/sandboxes', { method: 'POST', headers: { authorization: 'Bearer secret', 'content-length': String(9 * 1024 * 1024) }, body: '{}' }),
      s.deps,
    )
    expect(r.status).toBe(413)
    expect(s.backend.create).not.toHaveBeenCalled()
  })
  it('aborts a streamed body that exceeds the cap without a content-length', async () => {
    const s = setup()
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= 20) return c.close()
        c.enqueue(chunk)
      },
    })
    const r = await handle(
      new Request('https://bridge.test/v1/sandboxes', { method: 'POST', headers: { authorization: 'Bearer secret' }, body, duplex: 'half' } as RequestInit),
      s.deps,
    )
    expect(r.status).toBe(413)
    expect(sent).toBeLessThan(20)
  })
})

describe('operations', () => {
  it('exec, files, ports, delete', async () => {
    const s = setup({ BRIDGE_TOKEN: 'secret', PREVIEW_HOSTNAME: 'p.example' })
    await s.req('POST', '/v1/sandboxes', { env: { A: '1' } })
    expect(s.backend.create).toHaveBeenCalledWith('cf-1', { A: '1' })
    expect(await (await s.req('POST', '/v1/sandboxes/cf-1/exec', { command: 'echo hi' })).json()).toMatchObject({ stdout: 'ran:echo hi' })
    expect(await (await s.req('POST', '/v1/sandboxes/cf-1/files/read', { path: '/a' })).json()).toEqual({ contentBase64: 'aGk=' })
    expect((await s.req('POST', '/v1/sandboxes/cf-1/files/write', { path: '/a', contentBase64: 'aGk=' })).status).toBe(200)
    expect(await (await s.req('POST', '/v1/sandboxes/cf-1/ports', { port: 8080 })).json()).toEqual({ url: 'https://x' })
    expect((await s.req('POST', '/v1/sandboxes/cf-1/ports', { port: 3000 })).status).toBe(400)
    expect((await s.req('DELETE', '/v1/sandboxes/cf-1')).status).toBe(200)
    expect(s.backend.destroy).toHaveBeenCalledWith('cf-1')
    expect((await s.req('GET', '/v1/sandboxes/cf-1')).status).toBe(404)
  })
  it('port exposure without a preview hostname is a clear 501', async () => {
    const s = setup()
    await s.req('POST', '/v1/sandboxes', {})
    expect((await s.req('POST', '/v1/sandboxes/cf-1/ports', { port: 8080 })).status).toBe(501)
  })
  it('validates input', async () => {
    const s = setup()
    await s.req('POST', '/v1/sandboxes', {})
    expect((await s.req('POST', '/v1/sandboxes/cf-1/exec', {})).status).toBe(400)
    expect((await s.req('GET', '/other')).status).toBe(404)
  })
})
