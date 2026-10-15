import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Sandbox, SandboxInfo, SandboxProvider } from '@sandbank.dev/core'
import { createServer, defaultRegistry, UI_MIME, UI_URI } from '../src/index.js'
import { startHttp } from '../src/http.js'
import type { ProviderRegistry } from '../src/index.js'

function fakeProvider(): SandboxProvider {
  const files = new Map<string, Uint8Array>()
  const infos = new Map<string, SandboxInfo>()
  const make = (id: string): Sandbox =>
    ({
      id,
      state: 'running',
      createdAt: '2026-01-01T00:00:00Z',
      exec: async (command: string, opts?: { cwd?: string }) =>
        command === 'boom'
          ? { exitCode: 3, stdout: '', stderr: 'bad' }
          : { exitCode: 0, stdout: `ran:${command}:${opts?.cwd ?? ''}`, stderr: '' },
      readFile: async (p: string) => {
        const f = files.get(p)
        if (!f) throw new Error(`no such file ${p}`)
        return f
      },
      writeFile: async (p: string, c: string | Uint8Array) => {
        files.set(p, typeof c === 'string' ? new TextEncoder().encode(c) : c)
      },
      exposePort: async (port: number) => ({ url: `https://${port}-${id}.example` }),
    }) as unknown as Sandbox
  return {
    name: 'fake',
    capabilities: new Set(['port.expose']),
    create: async (cfg) => {
      const id = `sb-${infos.size + 1}`
      infos.set(id, { id, state: 'running', createdAt: '2026-01-01T00:00:00Z', image: cfg.image ?? 'default' })
      return make(id)
    },
    get: async (id) => {
      if (!infos.has(id)) throw new Error(`not found ${id}`)
      return make(id)
    },
    list: async () => [...infos.values()],
    destroy: async (id) => {
      infos.delete(id)
    },
  }
}

async function connect(registry: ProviderRegistry) {
  const server = createServer({ registry, html: '<html>console</html>' })
  const client = new Client({ name: 't', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

const call = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] }

describe('sandbank mcp server', () => {
  const fake = fakeProvider()
  const registry: ProviderRegistry = {
    fake: { configured: true, get: () => fake },
    off: { configured: false, get: () => fake },
  }

  it('lists tools; only render_console has a ui resourceUri', async () => {
    const c = await connect(registry)
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['file_read', 'file_write', 'port_expose', 'providers_list', 'render_console', 'sandbox_create', 'sandbox_destroy', 'sandbox_exec', 'sandbox_list'],
    )
    const withUi = tools.filter((t) => (t._meta as any)?.ui?.resourceUri)
    expect(withUi.map((t) => t.name)).toEqual(['render_console'])
    expect((withUi[0]!._meta as any).ui.resourceUri).toBe(UI_URI)
  })

  it('runs every tool', async () => {
    const c = await connect(registry)
    expect((await call(c, 'providers_list', {})).structuredContent.providers).toEqual([
      { name: 'fake', configured: true, capabilities: ['port.expose'] },
      { name: 'off', configured: false, capabilities: [] },
    ])
    const created = await call(c, 'sandbox_create', { provider: 'fake', image: 'alpine' })
    expect(created.structuredContent.sandbox).toEqual({
      provider: 'fake', id: 'sb-1', state: 'running', createdAt: '2026-01-01T00:00:00Z', image: 'alpine',
    })
    expect((await call(c, 'sandbox_list', {})).structuredContent.sandboxes).toHaveLength(1)
    expect((await call(c, 'sandbox_list', { provider: 'fake' })).structuredContent.sandboxes[0].id).toBe('sb-1')

    const ex = (await call(c, 'sandbox_exec', { provider: 'fake', id: 'sb-1', command: 'ls', cwd: '/w' })).structuredContent
    expect(ex).toMatchObject({ id: 'sb-1', command: 'ls', exitCode: 0, stdout: 'ran:ls:/w', stderr: '' })
    expect(typeof ex.durationMs).toBe('number')

    expect((await call(c, 'file_write', { provider: 'fake', id: 'sb-1', path: '/a', content: 'héllo' })).structuredContent).toEqual({ path: '/a', bytes: 6 })
    expect((await call(c, 'file_read', { provider: 'fake', id: 'sb-1', path: '/a' })).structuredContent).toEqual({ path: '/a', encoding: 'utf8', content: 'héllo', bytes: 6 })
    await call(c, 'file_write', { provider: 'fake', id: 'sb-1', path: '/b', content: '/wA=', encoding: 'base64' })
    expect((await call(c, 'file_read', { provider: 'fake', id: 'sb-1', path: '/b' })).structuredContent).toEqual({ path: '/b', encoding: 'base64', content: '/wA=', bytes: 2 })

    expect((await call(c, 'port_expose', { provider: 'fake', id: 'sb-1', port: 80 })).structuredContent).toEqual({ url: 'https://80-sb-1.example' })

    const con = (await call(c, 'render_console', { focusId: 'sb-1' })).structuredContent
    expect(con.focusId).toBe('sb-1')
    expect(con.sandboxes).toHaveLength(1)

    expect((await call(c, 'sandbox_destroy', { provider: 'fake', id: 'sb-1' })).structuredContent).toEqual({ id: 'sb-1', destroyed: true })
    expect((await call(c, 'sandbox_list', {})).structuredContent.sandboxes).toEqual([])
  })

  it('returns isError for failures', async () => {
    const c = await connect(registry)
    for (const [name, args, msg] of [
      ['sandbox_list', { provider: 'nope' }, /Unknown provider/],
      ['sandbox_create', { provider: 'off' }, /not configured/],
      ['sandbox_exec', { provider: 'fake', id: 'missing', command: 'x' }, /not found/],
    ] as const) {
      const r = await call(c, name, args)
      expect(r.isError).toBe(true)
      expect(r.content[0]!.text).toMatch(msg)
    }
  })

  it('serves the ui resource with mimeType and csp', async () => {
    const c = await connect(registry)
    const { resources } = await c.listResources()
    expect(resources.map((r) => r.uri)).toEqual([UI_URI])
    const { contents } = await c.readResource({ uri: UI_URI })
    expect(contents[0]).toMatchObject({ uri: UI_URI, mimeType: UI_MIME, text: '<html>console</html>' })
    expect((contents[0]!._meta as any).ui.csp.frameDomains).toEqual(['https://*.sbx.agent-next.com'])
  })

  it('keeps listing other providers when one is down', async () => {
    const down = { ...fakeProvider(), list: async () => { throw new Error('docker daemon unreachable') } }
    const c = await connect({ fake: registry.fake!, down: { configured: true, get: () => down } })
    await call(c, 'sandbox_create', { provider: 'fake' })
    const r = await call(c, 'sandbox_list', {})
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent.sandboxes.map((s: any) => s.provider)).toContain('fake')
    expect((await call(c, 'sandbox_list', { provider: 'down' })).isError).toBe(true)
  })

  it('refuses file_read over 1 MB', async () => {
    const c = await connect(registry)
    const id = (await call(c, 'sandbox_create', { provider: 'fake' })).structuredContent.sandbox.id
    await call(c, 'file_write', { provider: 'fake', id, path: '/big', content: 'x'.repeat(1_000_001) })
    const r = await call(c, 'file_read', { provider: 'fake', id, path: '/big' })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/at most 1000000/)
  })

  it('treats an unexpanded ${SBX_API_KEY} placeholder as not configured', () => {
    expect(defaultRegistry({ SBX_API_KEY: '${SBX_API_KEY}' }).sbx!.configured).toBe(false)
    expect(defaultRegistry({ SBX_API_KEY: 'k' }).sbx!.configured).toBe(true)
  })
})

describe('sandbank mcp --http', () => {
  it('rejects foreign Host and Origin headers', async () => {
    const port = 39000 + Math.floor(Math.random() * 1000)
    const http = await startHttp(port, { registry: {}, html: '' })
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      })
      expect((await post({})).status).toBe(200)
      expect((await post({ origin: 'https://evil.example' })).status).toBe(403)
      // fetch cannot override Host, so send this one with node:http.
      const hostStatus = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `evil.example:${port}` } },
          (res) => { res.resume(); resolve(res.statusCode ?? 0) })
        req.on('error', reject)
        req.end(body)
      })
      expect(hostStatus).toBe(403)
    } finally {
      http.close()
    }
  })
})
