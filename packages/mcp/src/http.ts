import { createServer as createHttpServer } from 'node:http'
import type { Server } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'
import type { CreateServerOptions } from './server.js'

/** Stateless Streamable HTTP endpoint at /mcp, bound to 127.0.0.1. */
export function startHttp(port: number, options?: CreateServerOptions): Promise<Server> {
  // Local-only: refuse other Host headers (DNS rebinding) and any browser Origin that is not local.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const localOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
  // Stateless: a fresh server + transport per request.
  const http = createHttpServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    const origin = req.headers.origin
    if (!hosts.has(req.headers.host ?? '') || (origin && !localOrigin.test(origin))) {
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
  return new Promise((resolve) => http.listen(port, '127.0.0.1', () => resolve(http)))
}
