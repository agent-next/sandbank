import { timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { Server } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'
import type { CreateServerOptions } from './server.js'

export interface HttpOptions {
  /**
   * Hosted mode: listen on all interfaces and serve only `/mcp/<token>` from any Host.
   * The secret path is the credential (MCP connectors in Claude/ChatGPT cannot always send headers).
   */
  token?: string
}

/** Stateless Streamable HTTP endpoint: local-only at /mcp, or hosted at /mcp/<token>. */
export function startHttp(port: number, options?: CreateServerOptions, httpOptions: HttpOptions = {}): Promise<Server> {
  const { token } = httpOptions
  const hostedPath = token ? Buffer.from(`/mcp/${token}`) : undefined
  // Local-only: refuse other Host headers (DNS rebinding) and any browser Origin that is not local.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const localOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
  // Stateless: a fresh server + transport per request.
  const http = createHttpServer(async (req, res) => {
    const path = req.url?.split('?')[0] ?? ''
    if (hostedPath) {
      const got = Buffer.from(path)
      if (got.length !== hostedPath.length || !timingSafeEqual(got, hostedPath)) {
        res.writeHead(404).end()
        return
      }
    } else if (path !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    const origin = req.headers.origin
    if (!hostedPath && (!hosts.has(req.headers.host ?? '') || (origin && !localOrigin.test(origin)))) {
      res.writeHead(403).end('forbidden host or origin')
      return
    }
    const server = createServer(options)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(e))
    }
  })
  return new Promise((resolve) => http.listen(port, token ? '0.0.0.0' : '127.0.0.1', () => resolve(http)))
}
