import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SandboxNotFoundError, ProviderError } from '@sandbank.dev/core'
import type { InstaBoxClient, InstaBoxMachine, InstaBoxOperation } from '../src/types.js'
import { InstaBoxApiError } from '../src/rest-client.js'

// --- Mock client ---

function freshMachine(overrides?: Partial<InstaBoxMachine>): InstaBoxMachine {
  return {
    id: 'sb-123',
    name: 'sb-abc12345',
    state: 'running',
    createdAt: '2026-01-01T00:00:00Z',
    snapshot: { id: 'sn_base' },
    ...overrides,
  }
}

function op(partial: Partial<InstaBoxOperation>): InstaBoxOperation {
  return {
    id: 'op-1',
    machineId: 'sb-123',
    type: 'create',
    state: 'queued',
    error: null,
    ...partial,
  }
}

function apiError(status: number, code: string, operationId: string | null = null): InstaBoxApiError {
  return new InstaBoxApiError(status, code, 'from test', 'req-1', false, operationId)
}

function createMockClient(): InstaBoxClient {
  return {
    createMachine: vi.fn<InstaBoxClient['createMachine']>().mockResolvedValue(
      op({ state: 'succeeded', machine: freshMachine() }),
    ),
    getMachine: vi.fn<InstaBoxClient['getMachine']>().mockResolvedValue(freshMachine()),
    listMachines: vi.fn<InstaBoxClient['listMachines']>().mockResolvedValue({ machines: [], nextCursor: null }),
    deleteMachine: vi.fn<InstaBoxClient['deleteMachine']>().mockResolvedValue(
      op({ type: 'delete', state: 'succeeded' }),
    ),
    machineAction: vi.fn<InstaBoxClient['machineAction']>().mockResolvedValue(
      op({ type: 'suspend', state: 'succeeded' }),
    ),
    getOperation: vi.fn<InstaBoxClient['getOperation']>().mockResolvedValue(op({ state: 'succeeded' })),
    exec: vi.fn<InstaBoxClient['exec']>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false,
    }),
    readFile: vi.fn<InstaBoxClient['readFile']>().mockResolvedValue({
      path: '/f', type: 'file', size: 0, mode: '-rw-r--r--', modTime: '2026-01-01T00:00:00Z', content: '',
    }),
    publishPort: vi.fn<InstaBoxClient['publishPort']>().mockResolvedValue({
      id: 'p1', machineId: 'sb-123', port: 3000, name: 'Port 3000',
      url: 'https://p1.example.com', createdAt: '2026-01-01T00:00:00Z',
    }),
    createSnapshot: vi.fn<InstaBoxClient['createSnapshot']>().mockResolvedValue({
      id: 'sn_new', name: 'snap-1', status: 'ready', createdAt: '2026-01-01T00:00:00Z',
    }),
    getSnapshot: vi.fn<InstaBoxClient['getSnapshot']>().mockResolvedValue({
      id: 'sn_new', name: 'snap-1', status: 'ready', createdAt: '2026-01-01T00:00:00Z',
    }),
  }
}

let mockClient: ReturnType<typeof createMockClient>

// Mock the rest-client factory (the adapter's only client source)
vi.mock('../src/rest-client.js', () => ({
  createInstaBoxRestClient: vi.fn(() => mockClient),
  InstaBoxApiError: class extends Error {
    status: number
    code: string
    requestId: string
    retryable: boolean
    operationId: string | null
    constructor(
      status: number, code: string, message: string, requestId: string, retryable: boolean, operationId: string | null,
    ) {
      super(message)
      this.status = status
      this.code = code
      this.requestId = requestId
      this.retryable = retryable
      this.operationId = operationId
    }
  },
}))

import { InstaBoxAdapter } from '../src/adapter.js'

function createAdapter(config?: { asRoot?: boolean }) {
  return new InstaBoxAdapter({ apiKey: 'test-key', apiUrl: 'https://api.test.com', ...config })
}

describe('InstaBoxAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient = createMockClient()
  })

  // --- Identity ---
  describe('identity', () => {
    it('should have name instabox and correct capabilities', () => {
      const adapter = createAdapter()
      expect(adapter.name).toBe('instabox')
      expect(adapter.capabilities).toEqual(new Set(['sleep', 'port.expose']))
    })

    it('should not have exec.stream, terminal, or volumes capabilities', () => {
      const adapter = createAdapter()
      expect(adapter.capabilities.has('exec.stream' as never)).toBe(false)
      expect(adapter.capabilities.has('terminal' as never)).toBe(false)
      expect(adapter.capabilities.has('volumes' as never)).toBe(false)
    })

    it('should not have the snapshot capability (no in-place restore)', () => {
      const adapter = createAdapter()
      expect(adapter.capabilities.has('snapshot' as never)).toBe(false)
    })
  })

  // --- createSandbox ---
  describe('createSandbox', () => {
    it('should create a machine and return the wrapped sandbox', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ image: 'universal' })

      expect(sandbox.id).toBe('sb-123')
      expect(sandbox.state).toBe('running')
      expect(sandbox.createdAt).toBe('2026-01-01T00:00:00Z')
      expect(mockClient.createMachine).toHaveBeenCalled()
    })

    it('should send the create body with kill-on-timeout and the sandbank label', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({ image: 'dev', autoDestroyMinutes: 30 })

      expect(mockClient.createMachine).toHaveBeenCalledWith({
        name: expect.stringMatching(/^sb-[0-9a-f]{8}$/),
        templateId: 'dev',
        timeoutSeconds: 1800,
        onTimeout: 'kill',
        metadata: { source: 'sandbank' },
        vault: false,
      })
    })

    it('should default to the universal template', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({})

      const body = (mockClient.createMachine as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(body.templateId).toBe('universal')
    })

    it('should omit timeoutSeconds/onTimeout when autoDestroyMinutes is 0 (no auto-destroy)', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({ autoDestroyMinutes: 0 })

      const body = (mockClient.createMachine as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(body.timeoutSeconds).toBeUndefined()
      expect(body.onTimeout).toBeUndefined()
    })

    it('should omit timeoutSeconds/onTimeout when autoDestroyMinutes is omitted', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({})

      const body = (mockClient.createMachine as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(body.timeoutSeconds).toBeUndefined()
      expect(body.onTimeout).toBeUndefined()
    })

    it('should clamp timeoutSeconds to 60..14400 when autoDestroyMinutes > 0', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({ autoDestroyMinutes: 1 })
      expect((mockClient.createMachine as ReturnType<typeof vi.fn>).mock.calls[0][0].timeoutSeconds).toBe(60)

      await adapter.createSandbox({ autoDestroyMinutes: 100000 })
      expect((mockClient.createMachine as ReturnType<typeof vi.fn>).mock.calls[1][0].timeoutSeconds).toBe(14400)
    })

    it('should map an sn_ image to snapshotId', async () => {
      const adapter = createAdapter()
      await adapter.createSandbox({ image: 'sn_abc' })

      const body = (mockClient.createMachine as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(body.snapshotId).toBe('sn_abc')
      expect(body.templateId).toBeUndefined()
    })

    it('should poll the operation until it succeeds', async () => {
      ;(mockClient.createMachine as ReturnType<typeof vi.fn>).mockResolvedValue(op({ state: 'queued' }))
      ;(mockClient.getOperation as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(op({ state: 'running' }))
        .mockResolvedValueOnce(op({ state: 'succeeded', machine: freshMachine() }))

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})

      expect(mockClient.getOperation).toHaveBeenCalledTimes(2)
      expect(mockClient.getOperation).toHaveBeenCalledWith('op-1', 25)
      expect(sandbox.id).toBe('sb-123')
    })

    it('should throw ProviderError when the operation fails', async () => {
      ;(mockClient.createMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
        op({ state: 'failed', error: { code: 'no_capacity', message: 'full' } }),
      )

      const adapter = createAdapter()
      await expect(adapter.createSandbox({})).rejects.toThrow(ProviderError)
    })

    it('should wrap client errors in ProviderError', async () => {
      ;(mockClient.createMachine as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('quota exceeded'))
      const adapter = createAdapter()
      await expect(adapter.createSandbox({})).rejects.toThrow(ProviderError)
    })
  })

  // --- getSandbox ---
  describe('getSandbox', () => {
    it('should return the wrapped sandbox', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.getSandbox('sb-123')
      expect(sandbox.id).toBe('sb-123')
      expect(mockClient.getMachine).toHaveBeenCalledWith('sb-123')
    })

    it('should preserve env set at create through getSandbox', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ env: { FOO: 'bar' } })
      expect((sandbox as unknown as { id: string }).id).toBe('sb-123')

      const fetched = await adapter.getSandbox('sb-123')
      await (fetched as unknown as { exec: (c: string) => Promise<unknown> }).exec('echo $FOO')

      expect((mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].envs).toEqual({ FOO: 'bar' })
    })

    it('should throw SandboxNotFoundError on 404', async () => {
      ;(mockClient.getMachine as ReturnType<typeof vi.fn>).mockRejectedValue(apiError(404, 'not_found'))
      const adapter = createAdapter()
      await expect(adapter.getSandbox('missing')).rejects.toThrow(SandboxNotFoundError)
    })

    it('should throw ProviderError on other errors', async () => {
      ;(mockClient.getMachine as ReturnType<typeof vi.fn>).mockRejectedValue(apiError(401, 'unauthenticated'))
      const adapter = createAdapter()
      await expect(adapter.getSandbox('sb-123')).rejects.toThrow(ProviderError)
    })
  })

  // --- listSandboxes ---
  describe('listSandboxes', () => {
    it('should follow cursors across pages', async () => {
      ;(mockClient.listMachines as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          machines: [freshMachine({ id: 'sb-1' }), freshMachine({ id: 'sb-2', state: 'stopped' })],
          nextCursor: 'cur-1',
        })
        .mockResolvedValueOnce({
          machines: [freshMachine({ id: 'sb-3' })],
          nextCursor: null,
        })

      const adapter = createAdapter()
      const list = await adapter.listSandboxes()

      expect(list.map((s) => s.id)).toEqual(['sb-1', 'sb-2', 'sb-3'])
      expect(mockClient.listMachines).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: undefined })
      expect(mockClient.listMachines).toHaveBeenNthCalledWith(2, { cursor: 'cur-1', limit: undefined })
    })

    it('should stop paging once the limit is reached', async () => {
      ;(mockClient.listMachines as ReturnType<typeof vi.fn>).mockResolvedValue({
        machines: [freshMachine({ id: 'sb-1' }), freshMachine({ id: 'sb-2' })],
        nextCursor: 'cur-1',
      })

      const adapter = createAdapter()
      const list = await adapter.listSandboxes({ limit: 2 })

      expect(list).toHaveLength(2)
      expect(mockClient.listMachines).toHaveBeenCalledTimes(1)
    })

    it('should apply the state filter before counting toward the limit', async () => {
      // Page 1 has one stopped machine; page 2 has the running one.
      ;(mockClient.listMachines as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          machines: [freshMachine({ id: 'sb-stop', state: 'stopped' })],
          nextCursor: 'cur-1',
        })
        .mockResolvedValueOnce({
          machines: [freshMachine({ id: 'sb-run', state: 'running' })],
          nextCursor: null,
        })

      const adapter = createAdapter()
      const running = await adapter.listSandboxes({ state: 'running', limit: 1 })

      expect(running.map((s) => s.id)).toEqual(['sb-run'])
      expect(mockClient.listMachines).toHaveBeenCalledTimes(2)
    })

    it('should map states and filter', async () => {
      ;(mockClient.listMachines as ReturnType<typeof vi.fn>).mockResolvedValue({
        machines: [
          freshMachine({ id: 'sb-1', state: 'running' }),
          freshMachine({ id: 'sb-2', state: 'suspended' }),
          freshMachine({ id: 'sb-3', state: 'starting' }),
        ],
        nextCursor: null,
      })

      const adapter = createAdapter()
      const running = await adapter.listSandboxes({ state: 'running' })
      expect(running.map((s) => s.id)).toEqual(['sb-1'])

      const stoppedish = await adapter.listSandboxes({ state: ['stopped', 'creating'] })
      expect(stoppedish.map((s) => s.id)).toEqual(['sb-2', 'sb-3'])
    })

    it('should map image to template.id when no snapshot is present', async () => {
      ;(mockClient.listMachines as ReturnType<typeof vi.fn>).mockResolvedValue({
        machines: [freshMachine({ id: 'sb-t', snapshot: undefined, template: { id: 'ubuntu' } })],
        nextCursor: null,
      })

      const adapter = createAdapter()
      const list = await adapter.listSandboxes()
      expect(list[0]!.image).toBe('ubuntu')
    })

    it('should prefer snapshot.id over template.id for image', async () => {
      ;(mockClient.listMachines as ReturnType<typeof vi.fn>).mockResolvedValue({
        machines: [freshMachine({ id: 'sb-s', snapshot: { id: 'sn_1' }, template: { id: 'ubuntu' } })],
        nextCursor: null,
      })

      const adapter = createAdapter()
      const list = await adapter.listSandboxes()
      expect(list[0]!.image).toBe('sn_1')
    })

    it('should wrap errors in ProviderError', async () => {
      ;(mockClient.listMachines as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'))
      const adapter = createAdapter()
      await expect(adapter.listSandboxes()).rejects.toThrow(ProviderError)
    })
  })

  // --- destroySandbox ---
  describe('destroySandbox', () => {
    it('should wait for the delete operation', async () => {
      ;(mockClient.deleteMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
        op({ type: 'delete', state: 'succeeded' }),
      )

      const adapter = createAdapter()
      await adapter.destroySandbox('sb-123')

      expect(mockClient.deleteMachine).toHaveBeenCalledTimes(1)
    })

    it('should be idempotent on 404', async () => {
      ;(mockClient.deleteMachine as ReturnType<typeof vi.fn>).mockRejectedValue(apiError(404, 'not_found'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('missing')).resolves.toBeUndefined()
    })

    it('should wait for the in-flight operation on 409 and retry once', async () => {
      ;(mockClient.deleteMachine as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(apiError(409, 'operation_conflict', 'op-9'))
        .mockResolvedValueOnce(op({ type: 'delete', state: 'succeeded' }))
      ;(mockClient.getOperation as ReturnType<typeof vi.fn>).mockResolvedValue(
        op({ id: 'op-9', type: 'start', state: 'succeeded' }),
      )

      const adapter = createAdapter()
      await adapter.destroySandbox('sb-123')

      expect(mockClient.getOperation).toHaveBeenCalledWith('op-9', 25)
      expect(mockClient.deleteMachine).toHaveBeenCalledTimes(2)
    })

    it('should retry after a FAILED conflicting operation reaches a terminal state', async () => {
      ;(mockClient.deleteMachine as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(apiError(409, 'operation_conflict', 'op-9'))
        .mockResolvedValueOnce(op({ type: 'delete', state: 'succeeded' }))
      ;(mockClient.getOperation as ReturnType<typeof vi.fn>).mockResolvedValue(
        op({ id: 'op-9', type: 'resume', state: 'failed', error: { code: 'boom', message: 'x' } }),
      )

      const adapter = createAdapter()
      await adapter.destroySandbox('sb-123')

      expect(mockClient.getOperation).toHaveBeenCalledWith('op-9', 25)
      expect(mockClient.deleteMachine).toHaveBeenCalledTimes(2)
    })

    it('should resolve when the 409 retry finds the machine already gone', async () => {
      ;(mockClient.deleteMachine as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(apiError(409, 'operation_conflict', 'op-9'))
        .mockRejectedValueOnce(apiError(404, 'not_found'))
      ;(mockClient.getOperation as ReturnType<typeof vi.fn>).mockResolvedValue(
        op({ id: 'op-9', type: 'delete', state: 'succeeded' }),
      )

      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).resolves.toBeUndefined()
    })

    it('should throw ProviderError when the delete operation fails', async () => {
      ;(mockClient.deleteMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
        op({ type: 'delete', state: 'failed', error: { code: 'internal', message: 'boom' } }),
      )

      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).rejects.toThrow(ProviderError)
    })

    it('should throw ProviderError on other errors', async () => {
      ;(mockClient.deleteMachine as ReturnType<typeof vi.fn>).mockRejectedValue(apiError(401, 'unauthenticated'))
      const adapter = createAdapter()
      await expect(adapter.destroySandbox('sb-123')).rejects.toThrow(ProviderError)
    })
  })

  // --- Wrapped sandbox operations ---
  describe('wrapped sandbox', () => {
    it('exec should map the result and pass cwd/timeout', async () => {
      ;(mockClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: 'hello', stderr: 'warn', exitCode: 0, timedOut: false, truncated: false,
      })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      const result = await sandbox.exec('echo hello', { cwd: '/app', timeout: 5000 })

      expect(result).toEqual({ stdout: 'hello', stderr: 'warn', exitCode: 0 })
      expect(mockClient.exec).toHaveBeenCalledWith('sb-123', {
        cmd: `sudo -n -E bash -lc 'echo hello'`,
        cwd: '/app',
        envs: undefined,
        timeoutSeconds: 5,
      })
    })

    it('exec should wrap commands as root by default (sudo -n -E bash -lc)', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      await sandbox.exec('whoami')

      expect((mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].cmd).toBe(
        `sudo -n -E bash -lc 'whoami'`,
      )
    })

    it('exec should quote single quotes in the command', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      await sandbox.exec(`echo 'hi'`)

      expect((mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].cmd).toBe(
        `sudo -n -E bash -lc 'echo '\\''hi'\\'''`,
      )
    })

    it('exec should run unchanged as guest user when asRoot is false', async () => {
      const adapter = createAdapter({ asRoot: false })
      const sandbox = await adapter.createSandbox({})
      await sandbox.exec('whoami')

      expect((mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].cmd).toBe('whoami')
    })

    it('exec should default to 60s and clamp to the 600s API max', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})

      await sandbox.exec('a')
      expect((mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].timeoutSeconds).toBe(60)

      await sandbox.exec('b', { timeout: 900_000 })
      expect((mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[1][1].timeoutSeconds).toBe(600)
    })

    it('exec should preserve non-zero exit codes', async () => {
      ;(mockClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'nope', exitCode: 42, timedOut: false, truncated: false,
      })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      const result = await sandbox.exec('exit 42')
      expect(result.exitCode).toBe(42)
    })

    it('exec should replay the env vars from create', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({ env: { FOO: 'bar' } })
      await sandbox.exec('echo $FOO')

      expect((mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].envs).toEqual({ FOO: 'bar' })
    })

    it('writeFile should stream base64 content through exec stdin', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      await sandbox.writeFile!('/tmp/deep/a.txt', 'hi ☃')

      const call = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(call[0]).toBe('sb-123')
      expect(call[1].cmd).toContain(`mkdir -p "$(dirname`)
      // 'hi ☃' UTF-8 bytes, base64-encoded
      expect(call[1].stdin).toBe(btoa(String.fromCharCode(...new TextEncoder().encode('hi ☃'))))
    })

    it('writeFile should split content over 1 MiB into appending chunks under the stdin cap', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      const data = new Uint8Array(1_200_000).map((_, i) => i % 251)
      await sandbox.writeFile!('/tmp/big.bin', data)

      const calls = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls
      expect(calls).toHaveLength(3)
      expect(calls[0][1].cmd).toContain('base64 -d >')
      expect(calls[1][1].cmd).toContain('base64 -d >>')
      expect(calls[2][1].cmd).toContain('base64 -d >>')
      for (const c of calls) expect(c[1].stdin.length).toBeLessThan(1_048_576)
      const joined = calls.flatMap(c => [...Uint8Array.from(atob(c[1].stdin), ch => ch.charCodeAt(0))])
      expect(joined).toEqual([...data])
    })

    it('writeFile should quote the dirname substitution for paths with spaces', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      await sandbox.writeFile!('/tmp/space dir/nested/file.txt', 'x')

      const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].cmd
      expect(cmd).toContain('"$(dirname')
      expect(cmd).toContain('/tmp/space dir/nested/file.txt')
    })

    it('writeFile should run as guest user unchanged when asRoot is false', async () => {
      const adapter = createAdapter({ asRoot: false })
      const sandbox = await adapter.createSandbox({})
      await sandbox.writeFile!('/tmp/x.txt', 'y')

      const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].cmd
      expect(cmd).not.toContain('sudo')
      expect(cmd).toContain(`mkdir -p "$(dirname '/tmp/x.txt')"` )
    })

    it('writeFile should throw when the exec fails', async () => {
      ;(mockClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'permission denied', exitCode: 1, timedOut: false, truncated: false,
      })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      await expect(sandbox.writeFile!('/root/x', 'y')).rejects.toThrow('permission denied')
    })

    it('readFile fallback should fail the pipeline when dd fails', async () => {
      ;(mockClient.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        path: '/f.bin', type: 'file', size: 3, mode: '-rw-------', modTime: '2026-01-01T00:00:00Z', binary: true,
      })
      ;(mockClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: 'dd: Permission denied', exitCode: 1, timedOut: false, truncated: false,
      })

      const adapter = createAdapter({ asRoot: false })
      const sandbox = await adapter.createSandbox({})
      await expect(sandbox.readFile!('/f.bin')).rejects.toThrow('Permission denied')
      const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].cmd
      expect(cmd.startsWith('set -o pipefail; dd ')).toBe(true)
    })

    it('readFile should use the files endpoint for text files', async () => {
      ;(mockClient.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        path: '/f.txt', type: 'file', size: 5, mode: '-rw-r--r--', modTime: '2026-01-01T00:00:00Z', content: 'hello',
      })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      const bytes = await sandbox.readFile!('/f.txt')

      expect(new TextDecoder().decode(bytes)).toBe('hello')
      expect(mockClient.exec).not.toHaveBeenCalled()
    })

    it('readFile should fall back to exec base64 for binary files', async () => {
      ;(mockClient.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        path: '/bin', type: 'file', size: 3, mode: '-rw-r--r--', modTime: '2026-01-01T00:00:00Z',
        binary: true,
      })
      ;(mockClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: btoa('abc'), stderr: '', exitCode: 0, timedOut: false, truncated: false,
      })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      const bytes = await sandbox.readFile!('/bin')

      expect(Array.from(bytes)).toEqual([97, 98, 99]) // 'abc'
      expect((mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].cmd).toContain("dd if=")
    })

    it('readFile should chunk reads for files > 1 MiB and concatenate', async () => {
      // Simulate a 1,200,000-byte file: 3 chunks (512K + 512K + ~135K raw)
      const chunk1 = new Uint8Array(524288).fill(65)
      const chunk2 = new Uint8Array(524288).fill(66)
      const chunk3 = new Uint8Array(151424).fill(67)

      ;(mockClient.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        path: '/big', type: 'file', size: 1200000, mode: '-rw-r--r--', modTime: '2026-01-01T00:00:00Z',
        binary: true,
      })
      const execMock = mockClient.exec as ReturnType<typeof vi.fn>
      execMock
        .mockResolvedValueOnce({ stdout: toB64(chunk1), stderr: '', exitCode: 0, timedOut: false, truncated: false })
        .mockResolvedValueOnce({ stdout: toB64(chunk2), stderr: '', exitCode: 0, timedOut: false, truncated: false })
        .mockResolvedValueOnce({ stdout: toB64(chunk3), stderr: '', exitCode: 0, timedOut: false, truncated: false })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      const bytes = await sandbox.readFile!('/big')

      expect(bytes.length).toBe(1200000)
      expect(Array.from(bytes.slice(0, 3))).toEqual([65, 65, 65])
      expect(Array.from(bytes.slice(524288, 524291))).toEqual([66, 66, 66])
      expect(Array.from(bytes.slice(-3))).toEqual([67, 67, 67])
      expect(execMock).toHaveBeenCalledTimes(3)
      expect(execMock.mock.calls[0]![1].cmd).toContain('skip=0')
      expect(execMock.mock.calls[1]![1].cmd).toContain('skip=1')
      expect(execMock.mock.calls[2]![1].cmd).toContain('skip=2')
    })

    it('readFile should throw ProviderError when exec reports truncated', async () => {
      ;(mockClient.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        path: '/big', type: 'file', size: 2000000, mode: '-rw-r--r--', modTime: '2026-01-01T00:00:00Z',
        binary: true,
      })
      ;(mockClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: true,
      })

      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      await expect(sandbox.readFile!('/big')).rejects.toThrow(ProviderError)
    })

    it('readFile should run as guest user unchanged when asRoot is false', async () => {
      ;(mockClient.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        path: '/bin', type: 'file', size: 3, mode: '-rw-r--r--', modTime: '2026-01-01T00:00:00Z',
        binary: true,
      })
      ;(mockClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: btoa('abc'), stderr: '', exitCode: 0, timedOut: false, truncated: false,
      })

      const adapter = createAdapter({ asRoot: false })
      const sandbox = await adapter.createSandbox({})
      await sandbox.readFile!('/bin')

      const cmd = (mockClient.exec as ReturnType<typeof vi.fn>).mock.calls[0][1].cmd
      expect(cmd).not.toContain('sudo')
      expect(cmd).toContain(`dd if='/bin' bs=524288 skip=0 count=1 status=none | base64 -w0`)
    })

    it('sleep should suspend and wait for the operation', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      await sandbox.sleep!()

      expect(mockClient.machineAction).toHaveBeenCalledWith('sb-123', 'suspend')
    })

    it('wake should resume and wait for the operation', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      await sandbox.wake!()

      expect(mockClient.machineAction).toHaveBeenCalledWith('sb-123', 'resume')
    })

    it('exposePort should publish the port and return its URL', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      const result = await sandbox.exposePort!(3000)

      expect(result.url).toBe('https://p1.example.com')
      expect(mockClient.publishPort).toHaveBeenCalledWith('sb-123', 3000)
    })

    it('should not offer a snapshot interface (InstaBox has no in-place restore)', async () => {
      const adapter = createAdapter()
      const sandbox = await adapter.createSandbox({})
      expect('createSnapshot' in sandbox).toBe(false)
      expect('restoreSnapshot' in sandbox).toBe(false)
    })
  })

  // --- State mapping ---
  describe('state mapping', () => {
    const stateMap: Array<[string, string]> = [
      ['creating', 'creating'],
      ['starting', 'creating'],
      ['resuming', 'creating'],
      ['running', 'running'],
      ['stopping', 'stopped'],
      ['stopped', 'stopped'],
      ['suspending', 'stopped'],
      ['suspended', 'stopped'],
      ['deleting', 'terminated'],
      ['deleted', 'terminated'],
      ['error', 'error'],
      ['unknown_state_xyz', 'error'],
    ]

    for (const [instaboxState, expected] of stateMap) {
      it(`should map "${instaboxState}" to "${expected}"`, async () => {
        ;(mockClient.getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
          freshMachine({ state: instaboxState as InstaBoxMachine['state'] }),
        )

        const adapter = createAdapter()
        const sandbox = await adapter.getSandbox('sb-123')
        expect(sandbox.state).toBe(expected)
      })
    }
  })
})

// --- helpers ---
function toB64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
