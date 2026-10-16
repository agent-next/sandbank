import { describe, expect, it, vi } from 'vitest'
import { ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'
import { CloudflareBridgeAdapter } from '../src/client.js'

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const info = { id: 'cf-1', state: 'running', createdAt: 'c', expiresAt: 'e' }

function adapter(handler: (url: string, init: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}))
  return { fetch, a: new CloudflareBridgeAdapter({ url: 'https://b.test/', token: 'tok', fetch: fetch as never }) }
}

describe('CloudflareBridgeAdapter', () => {
  it('creates with the bearer token and maps lifetime', async () => {
    const { a, fetch } = adapter(() => reply(201, info))
    const sb = await a.createSandbox({ env: { A: '1' }, autoDestroyMinutes: 10 })
    expect(sb.id).toBe('cf-1')
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://b.test/v1/sandboxes')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toEqual({ env: { A: '1' }, lifetimeMinutes: 10 })
  })
  it('exec and file round trip', async () => {
    const { a } = adapter((url) =>
      url.endsWith('/exec') ? reply(200, { exitCode: 0, stdout: 'o', stderr: '' })
      : url.endsWith('/files/read') ? reply(200, { contentBase64: 'aGk=' })
      : url.endsWith('/files/write') ? reply(200, { ok: true })
      : url.endsWith('/ports') ? reply(200, { url: 'https://p' })
      : reply(200, info),
    )
    const sb = await a.getSandbox('cf-1')
    expect(await sb.exec('ls')).toEqual({ exitCode: 0, stdout: 'o', stderr: '' })
    expect(new TextDecoder().decode(await sb.readFile!('/a'))).toBe('hi')
    await sb.writeFile!('/a', 'hi')
    expect(await sb.exposePort!(8080)).toEqual({ url: 'https://p' })
  })
  it('maps 404 to SandboxNotFoundError and other failures to ProviderError', async () => {
    expect(await adapter(() => reply(404, {})).a.getSandbox('x').catch((e) => e)).toBeInstanceOf(SandboxNotFoundError)
    const err = await adapter(() => reply(429, { error: 'sandbox cap reached' })).a.createSandbox({}).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(String(err.cause)).toContain('cap reached')
  })
  it('destroy is idempotent on 404; lists with filter', async () => {
    expect(await adapter(() => reply(404, {})).a.destroySandbox('x')).toBeUndefined()
    const { a } = adapter(() => reply(200, { sandboxes: [info, { ...info, id: 'cf-2' }] }))
    expect((await a.listSandboxes({ limit: 1 })).map((s) => s.id)).toEqual(['cf-1'])
  })
})
