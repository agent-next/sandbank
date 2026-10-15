#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startHttp } from './http.js'
import { createServer } from './server.js'

const i = process.argv.indexOf('--http')
if (i === -1) {
  await createServer().connect(new StdioServerTransport())
} else {
  const port = Number(process.argv[i + 1])
  if (!Number.isInteger(port) || port <= 0) {
    console.error('usage: sandbank-mcp [--http <port>]')
    process.exit(2)
  }
  await startHttp(port)
  console.error(`sandbank-mcp listening on http://127.0.0.1:${port}/mcp`)
}
