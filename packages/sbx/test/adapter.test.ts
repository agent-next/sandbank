import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'

const mocks = vi.hoisted(() => {
  class MockNotFoundError extends Error {}
  class MockSandboxNotFoundError extends MockNotFoundError {}
  class MockCommandExitError extends Error {}

  return {
    Sandbox: {
      create: vi.fn(),
      connect: vi.fn(),
      list: vi.fn(),
      kill: vi.fn(),
    },
    NotFoundError: MockNotFoundError,
    SandboxNotFoundError: MockSandboxNotFoundError,
    CommandExitError: MockCommandExitError,
  }
})

vi.mock('e2b', () => ({
  Sandbox: mocks.Sandbox,
  Volume: {},
  NotFoundError: mocks.NotFoundError,
  SandboxNotFoundError: mocks.SandboxNotFoundError,
  CommandExitError: mocks.CommandExitError,
}))

import { SbxAdapter } from '../src/adapter.js'

function fakeSandbox(id = 'sbx-1') {
  return {
    sandboxId: id,
    getInfo: vi.fn().mockResolvedValue({
      sandboxId: id,
      templateId: 'base',
      state: 'running',
      startedAt: new Date('2026-10-15T00:00:00Z'),
    }),
  }
}

describe('SbxAdapter', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SBX_API_KEY
    delete process.env.SBX_DOMAIN
    delete process.env.E2B_API_KEY
    mocks.Sandbox.create.mockResolvedValue(fakeSandbox())
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('names itself sbx and offers no volumes', () => {
    const adapter = new SbxAdapter({ apiKey: 'k' })
    expect(adapter.name).toBe('sbx')
    expect([...adapter.capabilities].sort()).toEqual(['port.expose', 'sleep', 'terminal'])
    expect('createVolume' in adapter).toBe(false)
  })

  it('targets the sbx endpoints by default', async () => {
    await new SbxAdapter({ apiKey: 'k' }).createSandbox({ image: 'base' })
    const [template, opts] = mocks.Sandbox.create.mock.calls[0]
    expect(template).toBe('base')
    expect(opts).toMatchObject({
      apiKey: 'k',
      domain: 'sbx.agent-next.com',
      apiUrl: 'https://api.sbx.agent-next.com',
    })
  })

  it('reads SBX_API_KEY and SBX_DOMAIN, preferring SBX_API_KEY over E2B_API_KEY', async () => {
    process.env.SBX_API_KEY = 'sbx-key'
    process.env.E2B_API_KEY = 'e2b-key'
    process.env.SBX_DOMAIN = 'sbx.example.test'
    await new SbxAdapter().createSandbox({})
    expect(mocks.Sandbox.create.mock.calls[0][0]).toMatchObject({
      apiKey: 'sbx-key',
      domain: 'sbx.example.test',
      apiUrl: 'https://api.sbx.example.test',
    })
  })

  it('falls back to E2B_API_KEY', async () => {
    process.env.E2B_API_KEY = 'e2b-key'
    await new SbxAdapter().createSandbox({})
    expect(mocks.Sandbox.create.mock.calls[0][0]).toMatchObject({ apiKey: 'e2b-key' })
  })

  it('kills after 60 minutes by default instead of pausing', async () => {
    await new SbxAdapter({ apiKey: 'k' }).createSandbox({})
    expect(mocks.Sandbox.create.mock.calls[0][0]).toMatchObject({
      timeoutMs: 60 * 60_000,
      lifecycle: { onTimeout: 'kill' },
    })
  })

  it('honors an explicit autoDestroyMinutes', async () => {
    await new SbxAdapter({ apiKey: 'k', autoDestroyMinutes: 30 }).createSandbox({ autoDestroyMinutes: 5 })
    expect(mocks.Sandbox.create.mock.calls[0][0]).toMatchObject({ timeoutMs: 5 * 60_000 })
  })

  it('relabels provider errors as sbx', async () => {
    mocks.Sandbox.create.mockRejectedValue(new Error('boom'))
    const err = await new SbxAdapter({ apiKey: 'k' }).createSandbox({}).catch(e => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.provider).toBe('sbx')
    expect(err.message).toContain('boom')
  })

  it('relabels not-found as sbx', async () => {
    mocks.Sandbox.connect.mockRejectedValue(new mocks.SandboxNotFoundError('gone'))
    const err = await new SbxAdapter({ apiKey: 'k' }).getSandbox('missing').catch(e => e)
    expect(err).toBeInstanceOf(SandboxNotFoundError)
    expect(err.provider).toBe('sbx')
    expect(err.sandboxId).toBe('missing')
  })

  it('treats destroying a missing sandbox as done', async () => {
    mocks.Sandbox.kill.mockRejectedValue(new mocks.SandboxNotFoundError('gone'))
    await expect(new SbxAdapter({ apiKey: 'k' }).destroySandbox('missing')).resolves.toBeUndefined()
  })

  it('lists through the sbx endpoints', async () => {
    mocks.Sandbox.list.mockReturnValue({
      hasNext: true,
      nextItems: vi.fn().mockImplementation(async function (this: { hasNext: boolean }) {
        this.hasNext = false
        return [{ sandboxId: 's1', templateId: 'base', state: 'running', startedAt: '2026-10-15T00:00:00Z' }]
      }),
    })
    const list = await new SbxAdapter({ apiKey: 'k' }).listSandboxes()
    expect(list).toEqual([{ id: 's1', state: 'running', createdAt: '2026-10-15T00:00:00.000Z', image: 'base' }])
    expect(mocks.Sandbox.list.mock.calls[0][0]).toMatchObject({ apiUrl: 'https://api.sbx.agent-next.com' })
  })
})
