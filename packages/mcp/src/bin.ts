#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'

const i = process.argv.indexOf('--http')
if (i === -1) {
  await createServer().connect(new StdioServerTransport())
} else {
  const port = Number(process.argv[i + 1])
  if (!Number.isInteger(port) || port < 0) {
    console.error('usage: sandbank-mcp [--http <port>]')
    process.exit(2)
  }
  // Stateless: a fresh server + transport per request.
  const http = createHttpServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    const server = createServer()
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
  http.listen(port, '127.0.0.1', () => console.error(`sandbank-mcp listening on http://127.0.0.1:${port}/mcp`))
}
