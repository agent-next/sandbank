import type {
  InstaBoxClient,
  InstaBoxClientConfig,
  InstaBoxCreateMachineRequest,
  InstaBoxExecRequest,
  InstaBoxExecResult,
  InstaBoxFile,
  InstaBoxMachine,
  InstaBoxMachineList,
  InstaBoxOperation,
  InstaBoxPublicPort,
  InstaBoxSnapshot,
} from './types.js'

const DEFAULT_API_URL = 'https://api.instabox.sh'

/** Delay before the single retry of a retryable failed GET. */
const RETRY_DELAY_MS = 500

/** Error carrying the parsed InstaBox error body ({error:{code,message,...}}). */
export class InstaBoxApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string
  readonly retryable: boolean
  /** For `operation_conflict`: the active operation. */
  readonly operationId: string | null

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string,
    retryable: boolean,
    operationId: string | null,
  ) {
    super(`InstaBox API ${status} ${code}: ${message}`)
    this.name = 'InstaBoxApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.retryable = retryable
    this.operationId = operationId
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function createInstaBoxRestClient(config: InstaBoxClientConfig): InstaBoxClient {
  const baseUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, '')

  /** Lifecycle mutations answer 202 with an operation and require an idempotency key. */
  function idempotencyHeaders(): Record<string, string> {
    return { 'Idempotency-Key': crypto.randomUUID() }
  }

  async function parseErrorResponse(res: Response): Promise<InstaBoxApiError> {
    const fallback = new InstaBoxApiError(res.status, 'unknown', res.statusText || `HTTP ${res.status}`, '', false, null)
    try {
      const body = await res.json() as {
        error?: { code?: string; message?: string; requestId?: string; retryable?: boolean; operationId?: string | null }
      }
      if (!body.error) return fallback
      return new InstaBoxApiError(
        res.status,
        body.error.code ?? 'unknown',
        body.error.message ?? fallback.message,
        body.error.requestId ?? '',
        body.error.retryable ?? false,
        body.error.operationId ?? null,
      )
    } catch {
      // Non-JSON error body
      return fallback
    }
  }

  async function requestOnce<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'X-API-Key': config.apiKey,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!res.ok) throw await parseErrorResponse(res)
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await requestOnce<T>(path, init)
    } catch (err) {
      // GETs get one retry on retryable 429/503
      const isGet = init?.method === undefined || init.method === 'GET'
      if (
        isGet &&
        err instanceof InstaBoxApiError &&
        (err.status === 429 || err.status === 503) &&
        err.retryable
      ) {
        await delay(RETRY_DELAY_MS)
        return requestOnce<T>(path, init)
      }
      throw err
    }
  }

  function query(params: Record<string, string | number | string[] | undefined>): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue
      if (Array.isArray(value)) {
        for (const item of value) search.append(key, item)
      } else {
        search.append(key, String(value))
      }
    }
    const qs = search.toString()
    return qs ? `?${qs}` : ''
  }

  return {
    async createMachine(body: InstaBoxCreateMachineRequest): Promise<InstaBoxOperation> {
      return request<InstaBoxOperation>('/v1/machines', {
        method: 'POST',
        headers: idempotencyHeaders(),
        body: JSON.stringify(body),
      })
    },

    async getMachine(id: string): Promise<InstaBoxMachine> {
      return request<InstaBoxMachine>(`/v1/machines/${id}`)
    },

    async listMachines(params?: { metadata?: string[]; limit?: number; cursor?: string }): Promise<InstaBoxMachineList> {
      return request<InstaBoxMachineList>(`/v1/machines${query({
        metadata: params?.metadata,
        limit: params?.limit,
        cursor: params?.cursor,
      })}`)
    },

    async deleteMachine(id: string): Promise<InstaBoxOperation> {
      return request<InstaBoxOperation>(`/v1/machines/${id}`, {
        method: 'DELETE',
        headers: idempotencyHeaders(),
      })
    },

    async machineAction(id: string, action: 'start' | 'stop' | 'suspend' | 'resume'): Promise<InstaBoxOperation> {
      return request<InstaBoxOperation>(`/v1/machines/${id}/${action}`, {
        method: 'POST',
        headers: idempotencyHeaders(),
      })
    },

    async getOperation(id: string, waitSeconds?: number): Promise<InstaBoxOperation> {
      return request<InstaBoxOperation>(`/v1/operations/${id}${query({
        wait: waitSeconds != null ? `${waitSeconds}s` : undefined,
      })}`)
    },

    async exec(machineId: string, body: InstaBoxExecRequest): Promise<InstaBoxExecResult> {
      return request<InstaBoxExecResult>(`/v1/machines/${machineId}/exec`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    async readFile(machineId: string, path: string): Promise<InstaBoxFile> {
      return request<InstaBoxFile>(`/v1/machines/${machineId}/files${query({ path })}`)
    },

    async publishPort(machineId: string, port: number): Promise<InstaBoxPublicPort> {
      return request<InstaBoxPublicPort>(`/v1/machines/${machineId}/ports`, {
        method: 'POST',
        body: JSON.stringify({ port }),
      })
    },

    async createSnapshot(machineId: string, name: string): Promise<InstaBoxSnapshot> {
      return request<InstaBoxSnapshot>(`/v1/machines/${machineId}/snapshots`, {
        method: 'POST',
        headers: idempotencyHeaders(),
        body: JSON.stringify({ name }),
      })
    },

    async getSnapshot(id: string): Promise<InstaBoxSnapshot> {
      return request<InstaBoxSnapshot>(`/v1/snapshots/${id}`)
    },
  }
}
