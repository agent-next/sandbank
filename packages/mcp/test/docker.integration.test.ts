import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer, defaultRegistry } from '../src/index.js'

describe.skipIf(!process.env.DOCKER_INTEGRATION)('docker via MCP', () => {
  it('create -> exec -> destroy', async () => {
    const server = createServer({ registry: defaultRegistry(), html: '' })
    const client = new Client({ name: 't', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as any
      expect(r.isError).toBeFalsy()
      return r.structuredContent
    }
    const { sandbox } = await call('sandbox_create', { provider: 'docker', image: 'alpine:3.20' })
    try {
      const r = await call('sandbox_exec', { provider: 'docker', id: sandbox.id, command: 'echo hi && cat /etc/alpine-release' })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toMatch(/^hi\n3\.20/)
      expect((await call('sandbox_list', { provider: 'docker' })).sandboxes.map((s: any) => s.id)).toContain(sandbox.id)
    } finally {
      expect(await call('sandbox_destroy', { provider: 'docker', id: sandbox.id })).toEqual({ id: sandbox.id, destroyed: true })
    }
  }, 180_000)
})
