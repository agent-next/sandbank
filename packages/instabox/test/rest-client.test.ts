import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createInstaBoxRestClient, InstaBoxApiError } from '../src/rest-client.js'
import type { InstaBoxClient } from '../src/types.js'

// --- Mock fetch ---
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const API_URL = 'https://api.test.com'

function operation(): Record<string, unknown> {
  return { id: 'op-1', machineId: 'sb-1', type: 'create', state: 'queued', error: null }
}

describe('createInstaBoxRestClient', () => {
  let client: InstaBoxClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = createInstaBoxRestClient({ apiKey: 'test-api-key', apiUrl: API_URL })
  })

  // --- Auth header ---
  describe('authentication', () => {
    it('should include X-API-Key header on all requests', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'sb-1', state: 'running', createdAt: '' }))
      await client.getMachine('sb-1')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0]
      expect(init.headers['X-API-Key']).toBe('test-api-key')
    })
  })

  // --- Default API URL ---
  describe('default API URL', () => {
    it('should use the default API URL when none provided', async () => {
      const defaultClient = createInstaBoxRestClient({ apiKey: 'key' })
      mockFetch.mockResolvedValueOnce(jsonResponse({ machines: [], nextCursor: null }))
      await defaultClient.listMachines()

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.instabox.sh/v1/machines')
    })

    it('should strip trailing slash from API URL', async () => {
      const c = createInstaBoxRestClient({ apiKey: 'key', apiUrl: 'https://api.test.com/' })
      mockFetch.mockResolvedValueOnce(jsonResponse({ machines: [], nextCursor: null }))
      await c.listMachines()
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/v1/machines`)
    })
  })

  // --- createMachine ---
  describe('createMachine', () => {
    it('should POST to /v1/machines with an Idempotency-Key header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(operation(), 202))

      const result = await client.createMachine({
        name: 'sb-abc',
        templateId: 'universal',
        timeoutSeconds: 3600,
        onTimeout: 'kill',
        vault: false,
      })

      expect(result.id).toBe('op-1')
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/v1/machines`)
      expect(init.method).toBe('POST')
      expect(init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
      const body = JSON.parse(init.body)
      expect(body.name).toBe('sb-abc')
      expect(body.templateId).toBe('universal')
      expect(body.onTimeout).toBe('kill')
    })

    it('should send a distinct Idempotency-Key per call', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(operation(), 202)))
      await client.createMachine({ name: 'sb-a' })
      await client.createMachine({ name: 'sb-b' })

      const key1 = mockFetch.mock.calls[0][1].headers['Idempotency-Key']
      const key2 = mockFetch.mock.calls[1][1].headers['Idempotency-Key']
      expect(key1).not.toBe(key2)
    })
  })

  // --- getMachine ---
  describe('getMachine', () => {
    it('should GET /v1/machines/{id}', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'sb-1', state: 'running', createdAt: '' }))

      const machine = await client.getMachine('sb-1')
      expect(machine.id).toBe('sb-1')
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/v1/machines/sb-1`)
    })
  })

  // --- listMachines ---
  describe('listMachines', () => {
    it('should GET /v1/machines without params by default', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ machines: [], nextCursor: null }))

      await client.listMachines()
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/v1/machines`)
    })

    it('should repeat metadata filters, limit and cursor as query params', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ machines: [], nextCursor: null }))

      await client.listMachines({ metadata: ['source:sandbank', 'env:prod'], limit: 10, cursor: 'cur-1' })
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('metadata=source%3Asandbank')
      expect(url).toContain('metadata=env%3Aprod')
      expect(url).toContain('limit=10')
      expect(url).toContain('cursor=cur-1')
    })
  })

  // --- deleteMachine / machineAction ---
  describe('lifecycle mutations', () => {
    it('should DELETE /v1/machines/{id} with an Idempotency-Key header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...operation(), type: 'delete' }, 202))

      await client.deleteMachine('sb-1')

      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/v1/machines/sb-1`)
      expect(init.method).toBe('DELETE')
      expect(init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('should POST machine actions with an Idempotency-Key header', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ ...operation(), type: 'suspend' }, 202)))

      await client.machineAction('sb-1', 'suspend')
      await client.machineAction('sb-1', 'resume')

      const [url1, init1] = mockFetch.mock.calls[0]
      const [url2] = mockFetch.mock.calls[1]
      expect(url1).toBe(`${API_URL}/v1/machines/sb-1/suspend`)
      expect(init1.method).toBe('POST')
      expect(init1.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
      expect(url2).toBe(`${API_URL}/v1/machines/sb-1/resume`)
    })
  })

  // --- getOperation ---
  describe('getOperation', () => {
    it('should long-poll with ?wait=Ns', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...operation(), state: 'succeeded' }))

      await client.getOperation('op-1', 25)
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/v1/operations/op-1?wait=25s`)
    })

    it('should GET without wait when not provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(operation()))

      await client.getOperation('op-1')
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/v1/operations/op-1`)
    })
  })

  // --- exec ---
  describe('exec', () => {
    it('should POST the exec request body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        stdout: 'hi', stderr: '', exitCode: 0, timedOut: false, truncated: false,
      }))

      const result = await client.exec('sb-1', {
        cmd: 'echo hi',
        cwd: '/tmp',
        envs: { FOO: 'bar' },
        timeoutSeconds: 30,
      })

      expect(result.stdout).toBe('hi')
      expect(result.exitCode).toBe(0)
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/v1/machines/sb-1/exec`)
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body)).toEqual({
        cmd: 'echo hi',
        cwd: '/tmp',
        envs: { FOO: 'bar' },
        timeoutSeconds: 30,
      })
    })

    it('should return non-zero exit codes as-is (HTTP 200)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        stdout: '', stderr: 'nope', exitCode: 42, timedOut: false, truncated: false,
      }))

      const result = await client.exec('sb-1', { cmd: 'exit 42' })
      expect(result.exitCode).toBe(42)
    })
  })

  // --- readFile ---
  describe('readFile', () => {
    it('should GET /files with the encoded path', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        path: '/tmp/a.txt', type: 'file', size: 2, mode: '-rw-r--r--',
        modTime: '2026-01-01T00:00:00Z', content: 'hi',
      }))

      const file = await client.readFile('sb-1', '/tmp/a.txt')
      expect(file.content).toBe('hi')
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/v1/machines/sb-1/files?path=%2Ftmp%2Fa.txt`)
    })
  })

  // --- publishPort ---
  describe('publishPort', () => {
    it('should POST the port and return the public URL', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'p1', machineId: 'sb-1', port: 3000, name: 'Port 3000',
        url: 'https://p1.instabox.app', createdAt: '2026-01-01T00:00:00Z',
      }, 201))

      const port = await client.publishPort('sb-1', 3000)
      expect(port.url).toBe('https://p1.instabox.app')

      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/v1/machines/sb-1/ports`)
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body)).toEqual({ port: 3000 })
    })
  })

  // --- snapshots ---
  describe('snapshots', () => {
    it('should POST /snapshots with an Idempotency-Key header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'sn_1', name: 'snap-1', status: 'pending', createdAt: '2026-01-01T00:00:00Z',
      }, 202))

      const snap = await client.createSnapshot('sb-1', 'snap-1')
      expect(snap.status).toBe('pending')

      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(`${API_URL}/v1/machines/sb-1/snapshots`)
      expect(init.method).toBe('POST')
      expect(init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
      expect(JSON.parse(init.body)).toEqual({ name: 'snap-1' })
    })

    it('should GET /v1/snapshots/{id}', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'sn_1', name: 'snap-1', status: 'ready', createdAt: '2026-01-01T00:00:00Z',
      }))

      const snap = await client.getSnapshot('sn_1')
      expect(snap.id).toBe('sn_1')
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/v1/snapshots/sn_1`)
    })
  })

  // --- Error handling ---
  describe('error handling', () => {
    it('should throw InstaBoxApiError with the parsed error body', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401, {
        error: { code: 'unauthenticated', message: 'bad key', requestId: 'req-1', retryable: false, operationId: null },
      }))

      const err = await client.getMachine('sb-1').catch((e) => e)
      expect(err).toBeInstanceOf(InstaBoxApiError)
      expect(err.status).toBe(401)
      expect(err.code).toBe('unauthenticated')
      expect(err.message).toContain('bad key')
      expect(err.requestId).toBe('req-1')
    })

    it('should capture operationId from operation_conflict', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(409, {
        error: {
          code: 'operation_conflict', message: 'an operation is active', requestId: 'req-2',
          retryable: true, operationId: 'op-9',
        },
      }))

      const err = await client.deleteMachine('sb-1').catch((e) => e)
      expect(err.status).toBe(409)
      expect(err.operationId).toBe('op-9')
    })

    it('should fall back to a generic error on a non-JSON body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))

      const err = await client.getMachine('sb-1').catch((e) => e)
      expect(err).toBeInstanceOf(InstaBoxApiError)
      expect(err.status).toBe(504)
      expect(err.code).toBe('unknown')
    })

    it('should retry a retryable 429 GET once and succeed', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(429, {
          error: { code: 'quota_exceeded', message: 'slow down', requestId: 'r', retryable: true, operationId: null },
        }))
        .mockResolvedValueOnce(jsonResponse({ id: 'sb-1', state: 'running', createdAt: '' }))

      const machine = await client.getMachine('sb-1')
      expect(machine.id).toBe('sb-1')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('should not retry a non-retryable 429 GET', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(429, {
        error: { code: 'quota_exceeded', message: 'monthly cap', requestId: 'r', retryable: false, operationId: null },
      }))

      await expect(client.getMachine('sb-1')).rejects.toThrow(InstaBoxApiError)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should not retry mutations even when retryable', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(503, {
        error: { code: 'host_unavailable', message: 'try later', requestId: 'r', retryable: true, operationId: null },
      }))

      await expect(client.deleteMachine('sb-1')).rejects.toThrow(InstaBoxApiError)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should handle fetch rejection', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'))
      await expect(client.getMachine('sb-1')).rejects.toThrow('network down')
    })
  })
})
