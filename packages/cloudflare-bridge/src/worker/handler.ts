import { isDrain } from './alarm-guard.js'
import { isAuthorized } from './auth.js'
import { MAX_BODY_BYTES, MAX_EXEC_TIMEOUT_MS } from './limits.js'
import { clampLifetimeMin, type ReserveResult, type SandboxEntry } from './registry-core.js'

export interface RegistryPort {
  reserve(id: string, lifetimeMin: number, now: number): Promise<ReserveResult>
  list(): Promise<SandboxEntry[]>
  release(id: string): Promise<void>
}

export interface Backend {
  create(id: string, env?: Record<string, string>): Promise<void>
  exec(id: string, command: string, opts: { cwd?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  readFile(id: string, path: string): Promise<string>
  writeFile(id: string, path: string, contentBase64: string): Promise<void>
  exposePort(id: string, port: number): Promise<{ url: string }>
  destroy(id: string): Promise<void>
}

export interface BridgeDeps {
  env: { BRIDGE_TOKEN?: string; DRAIN?: string; PREVIEW_HOSTNAME?: string; CREATE_DEADLINE?: string }
  registry: RegistryPort
  backend: Backend
  now: () => number
  newId: () => string
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const info = (e: SandboxEntry) => ({
  id: e.id,
  state: 'running',
  createdAt: new Date(e.createdAt).toISOString(),
  expiresAt: new Date(e.expiresAt).toISOString(),
})

/** Destroy sandboxes past their lifetime (or all of them when `all`), and drop them from the registry. */
export async function reap(deps: BridgeDeps, all = false): Promise<string[]> {
  const now = deps.now()
  const gone: string[] = []
  for (const e of await deps.registry.list()) {
    if (!all && e.expiresAt > now) continue
    await deps.backend.destroy(e.id).catch(() => {})
    await deps.registry.release(e.id)
    gone.push(e.id)
  }
  return gone
}

/** Reads the body, aborting as soon as it exceeds the cap (Content-Length can be absent or wrong). */
async function readCapped(request: Request): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new HttpError(413, 'request body too large')
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(all)
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
  const text = await readCapped(request)
  if (!text) return {}
  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new HttpError(400, 'body must be a JSON object')
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${name} must be a non-empty string`)
  return v
}

export async function handle(request: Request, deps: BridgeDeps): Promise<Response> {
  if (isDrain(deps.env)) return json(503, { error: 'bridge is draining' })
  if (!(await isAuthorized(request, deps.env.BRIDGE_TOKEN))) return json(401, { error: 'unauthorized' })

  try {
    const { pathname } = new URL(request.url)
    const parts = pathname.split('/').filter(Boolean)
    if (parts[0] !== 'v1' || parts[1] !== 'sandboxes') return json(404, { error: 'not found' })
    const [, , id, action, sub] = parts

    if (!id) {
      if (request.method === 'GET') {
        await reap(deps)
        return json(200, { sandboxes: (await deps.registry.list()).map(info) })
      }
      if (request.method === 'POST') {
        const body = await readJson(request)
        // Optional operator-set cutoff; an unparseable value fails closed.
        const cutoff = deps.env.CREATE_DEADLINE
        if (cutoff && !(deps.now() < Date.parse(cutoff))) return json(403, { error: 'sandbox creation is closed (deadline passed)', code: 'deadline' })
        await reap(deps)
        const newId = deps.newId()
        const r = await deps.registry.reserve(newId, clampLifetimeMin(body.lifetimeMinutes), deps.now())
        if (!r.ok) return json(429, { error: `sandbox cap reached (${r.max} concurrent); destroy one first`, code: 'capacity' })
        try {
          await deps.backend.create(newId, body.env as Record<string, string> | undefined)
        } catch (err) {
          await deps.registry.release(newId)
          throw err
        }
        return json(201, info(r.entry))
      }
      return json(405, { error: 'method not allowed' })
    }

    // Only registered ids reach the backend: an unknown id must never spawn a container.
    const entry = (await deps.registry.list()).find((e) => e.id === id)
    if (!entry) return json(404, { error: `sandbox '${id}' not found` })
    if (entry.expiresAt <= deps.now()) {
      await reap(deps)
      return json(410, { error: `sandbox '${id}' passed its lifetime and was destroyed` })
    }

    if (!action) {
      if (request.method === 'GET') return json(200, info(entry))
      if (request.method === 'DELETE') {
        await deps.backend.destroy(id).catch(() => {})
        await deps.registry.release(id)
        return json(200, { ok: true })
      }
      return json(405, { error: 'method not allowed' })
    }
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
    const body = await readJson(request)

    if (action === 'exec') {
      const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.min(body.timeoutMs, MAX_EXEC_TIMEOUT_MS) : MAX_EXEC_TIMEOUT_MS
      const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
      return json(200, await deps.backend.exec(id, str(body.command, 'command'), { cwd, timeoutMs }))
    }
    if (action === 'files' && sub === 'read') {
      return json(200, { contentBase64: await deps.backend.readFile(id, str(body.path, 'path')) })
    }
    if (action === 'files' && sub === 'write') {
      if (typeof body.contentBase64 !== 'string') throw new HttpError(400, 'contentBase64 must be a string')
      await deps.backend.writeFile(id, str(body.path, 'path'), body.contentBase64)
      return json(200, { ok: true })
    }
    if (action === 'ports') {
      // 3000 is reserved by the Sandbox SDK control plane inside the container.
      const port = body.port
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000) {
        throw new HttpError(400, 'port must be an integer in 1024-65535, excluding 3000')
      }
      if (!deps.env.PREVIEW_HOSTNAME) throw new HttpError(501, 'port exposure needs PREVIEW_HOSTNAME configured on the bridge')
      return json(200, await deps.backend.exposePort(id, port))
    }
    return json(404, { error: 'not found' })
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message })
    console.error('bridge request failed', err)
    return json(500, { error: 'internal error' })
  }
}
