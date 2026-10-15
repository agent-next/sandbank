import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { withPortExpose } from '@sandbank.dev/core'
import type { Sandbox, SandboxInfo, SandboxProvider } from '@sandbank.dev/core'
import { z } from 'zod'
import { defaultRegistry } from './registry.js'
import type { ProviderRegistry } from './registry.js'

export const UI_URI = 'ui://sandbank/console-v1.html'
export const UI_MIME = 'text/html;profile=mcp-app'
const UI_CSP = { frameDomains: ['https://*.sbx.agent-next.com'] }
const TEXT_LIMIT = 100_000
const FILE_LIMIT = 1_000_000

export interface SandboxRow {
  provider: string
  id: string
  state: string
  createdAt: string
  image: string
}

export interface CreateServerOptions {
  registry?: ProviderRegistry
  /** Console HTML; defaults to ./ui/console.html next to this module. */
  html?: string | (() => string)
}

const row = (provider: string, s: SandboxInfo | Sandbox, image = ''): SandboxRow => ({
  provider,
  id: s.id,
  state: s.state,
  createdAt: s.createdAt,
  image: 'image' in s ? s.image : image,
})

const ok = (text: string, structuredContent: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent,
})

const fail = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
})

const provider = z.string().describe('Provider name: docker or sbx')
const id = z.string().describe('Sandbox id')

export function createServer(options: CreateServerOptions = {}): McpServer {
  const registry = options.registry ?? defaultRegistry()
  const server = new McpServer({ name: 'sandbank', version: '0.1.0' })

  const resolve = (name: string): SandboxProvider => {
    const entry = registry[name]
    if (!entry) throw new Error(`Unknown provider "${name}" (available: ${Object.keys(registry).join(', ')})`)
    if (!entry.configured) throw new Error(`Provider "${name}" is not configured (set SBX_API_KEY or E2B_API_KEY)`)
    return entry.get()
  }

  const listRows = async (name?: string): Promise<SandboxRow[]> => {
    if (name) return (await resolve(name).list()).map((s) => row(name, s))
    // One unavailable provider (e.g. no docker daemon) must not hide the others.
    const names = Object.keys(registry).filter((n) => registry[n]!.configured)
    const lists = await Promise.allSettled(names.map(async (n) => (await resolve(n).list()).map((s) => row(n, s))))
    return lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  }

  // Wraps a handler so thrown errors become isError results.
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
    meta?: Record<string, unknown>,
  ) => {
    server.registerTool(name, { description, inputSchema: shape, ...(meta ? { _meta: meta } : {}) }, (async (args: unknown) => {
      try {
        return await run(args as z.infer<z.ZodObject<S>>)
      } catch (e) {
        return fail(e)
      }
    }) as never)
  }

  tool('providers_list', 'List sandbox providers and their capabilities', {}, async () => {
    const providers = Object.entries(registry).map(([name, e]) => ({
      name,
      configured: e.configured,
      capabilities: e.configured ? [...e.get().capabilities] : [],
    }))
    return ok(providers.map((p) => `${p.name}${p.configured ? '' : ' (not configured)'}`).join(', '), { providers })
  })

  tool(
    'sandbox_create',
    'Create a sandbox',
    {
      provider,
      image: z.string().optional(),
      env: z.record(z.string()).optional(),
      autoDestroyMinutes: z.number().optional(),
      ports: z.array(z.tuple([z.number(), z.number()])).optional().describe('[hostPort, guestPort] pairs'),
    },
    async ({ provider: p, image, env, autoDestroyMinutes, ports }) => {
      const sb = await resolve(p).create({ image, env, autoDestroyMinutes, ports })
      return ok(`Created ${p} sandbox ${sb.id}`, { sandbox: row(p, sb, image) })
    },
  )

  tool('sandbox_list', 'List sandboxes', { provider: provider.optional() }, async ({ provider: p }) => {
    const sandboxes = await listRows(p)
    return ok(`${sandboxes.length} sandbox(es)`, { sandboxes })
  })

  tool(
    'sandbox_exec',
    'Run a shell command in a sandbox',
    { provider, id, command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().optional() },
    async ({ provider: p, id: sid, command, cwd, timeoutMs }) => {
      const sb = await resolve(p).get(sid)
      const t0 = Date.now()
      const r = await sb.exec(command, { cwd, timeout: timeoutMs })
      const out = {
        id: sid, command, exitCode: r.exitCode,
        stdout: r.stdout.slice(-TEXT_LIMIT), stderr: r.stderr.slice(-TEXT_LIMIT), durationMs: Date.now() - t0,
      }
      return ok(`exit ${r.exitCode}\n${(r.stdout + r.stderr).slice(0, TEXT_LIMIT)}`, out)
    },
  )

  tool('file_read', 'Read a file from a sandbox', { provider, id, path: z.string() }, async ({ provider: p, id: sid, path }) => {
    const bytes = await (await resolve(p).get(sid)).readFile(path)
    if (bytes.length > FILE_LIMIT) {
      throw new Error(`${path} is ${bytes.length} bytes; file_read returns at most ${FILE_LIMIT}. Use sandbox_exec (head/tail/grep) instead.`)
    }
    const buf = Buffer.from(bytes)
    let content: string
    let encoding: 'utf8' | 'base64' = 'utf8'
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      content = buf.toString('base64')
      encoding = 'base64'
    }
    return ok(`${path}: ${buf.length} bytes (${encoding})`, { path, encoding, content, bytes: buf.length })
  })

  tool(
    'file_write',
    'Write a file into a sandbox',
    { provider, id, path: z.string(), content: z.string(), encoding: z.enum(['utf8', 'base64']).optional() },
    async ({ provider: p, id: sid, path, content, encoding }) => {
      const data = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8')
      await (await resolve(p).get(sid)).writeFile(path, new Uint8Array(data))
      return ok(`Wrote ${data.length} bytes to ${path}`, { path, bytes: data.length })
    },
  )

  tool('port_expose', 'Expose a sandbox port as a URL', { provider, id, port: z.number() }, async ({ provider: p, id: sid, port }) => {
    const exposer = withPortExpose(await resolve(p).get(sid))
    if (!exposer) throw new Error(`Provider "${p}" does not support port exposure`)
    const { url } = await exposer.exposePort(port)
    return ok(url, { url })
  })

  tool('sandbox_destroy', 'Destroy a sandbox', { provider, id }, async ({ provider: p, id: sid }) => {
    await resolve(p).destroy(sid)
    return ok(`Destroyed ${sid}`, { id: sid, destroyed: true })
  })

  tool(
    'render_console',
    'Show the interactive sandbox console',
    { focusId: z.string().optional(), provider: z.string().optional() },
    async ({ focusId, provider: p }) => {
      const sandboxes = await listRows(p)
      return ok(`${sandboxes.length} sandbox(es)`, { sandboxes, ...(focusId ? { focusId } : {}) })
    },
    { ui: { resourceUri: UI_URI } },
  )

  server.registerResource(
    'sandbank-console',
    UI_URI,
    { mimeType: UI_MIME, description: 'Sandbank sandbox console' },
    async (uri) => {
      const html = options.html ?? (() => readFileSync(new URL('./ui/console.html', import.meta.url), 'utf8'))
      return {
        contents: [
          { uri: uri.href, mimeType: UI_MIME, text: typeof html === 'function' ? html() : html, _meta: { ui: { csp: UI_CSP } } },
        ],
      }
    },
  )

  return server
}
