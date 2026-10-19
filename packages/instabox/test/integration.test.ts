import { describe, it, expect, afterAll } from 'vitest'
import { createProvider, withPortExpose, SandboxNotFoundError } from '@sandbank.dev/core'
import { InstaBoxAdapter, createInstaBoxRestClient } from '../src/index.js'

const API_KEY = process.env['INSTABOX_API_KEY'] ?? ''
const API_URL = process.env['INSTABOX_API_URL'] ?? 'https://api.instabox.sh'
const skip = !API_KEY

const adapter = new InstaBoxAdapter({ apiKey: API_KEY, apiUrl: API_URL })
const provider = createProvider(adapter)
const rest = createInstaBoxRestClient({ apiKey: API_KEY, apiUrl: API_URL })

const cleanupIds: string[] = []

afterAll(async () => {
  for (const id of cleanupIds) {
    try { await provider.destroy(id) } catch { /* best effort */ }
  }
})

describe.skipIf(skip)('InstaBoxAdapter integration', () => {
  it('create -> exec -> files -> exposePort -> destroy lifecycle', async () => {
    // --- create ---
    const sandbox = await provider.create({ image: 'universal', autoDestroyMinutes: 60 })
    cleanupIds.push(sandbox.id)
    expect(sandbox.id).toBeTruthy()
    expect(sandbox.state).toBe('running')
    console.log(`  created: ${sandbox.id}`)

    // --- exec ---
    const result = await sandbox.exec('echo hi')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hi')
    console.log('  exec ok')

    // --- writeFile / readFile round trip (UTF-8 multibyte) ---
    const content = 'Sandbank InstaBox test — 你好世界'
    await sandbox.writeFile('/tmp/sandbank-test.txt', content)
    const readBack = await sandbox.readFile('/tmp/sandbank-test.txt')
    expect(new TextDecoder().decode(readBack)).toBe(content)
    // binary over the 1 MiB exec stdin/stdout caps, path with a space
    const big = new Uint8Array(2_500_000).map((_, i) => (i * 31) % 256)
    await sandbox.writeFile('/tmp/sandbank dir/big.bin', big)
    expect(Buffer.from(await sandbox.readFile('/tmp/sandbank dir/big.bin')).equals(Buffer.from(big))).toBe(true)
    console.log('  file round trip ok')

    // --- exposePort ---
    const portExpose = withPortExpose(sandbox)
    expect(portExpose).not.toBeNull()
    if (portExpose) {
      const { url } = await portExpose.exposePort(8080)
      expect(url).toMatch(/^https?:\/\//)
      console.log(`  exposePort(8080) → ${url}`)
    }

    // --- destroy ---
    await provider.destroy(sandbox.id)
    cleanupIds.splice(cleanupIds.indexOf(sandbox.id), 1)

    // --- no leftover machine with our label ---
    const page = await rest.listMachines({ metadata: ['source:sandbank'] })
    expect(page.machines.find((m) => m.id === sandbox.id)).toBeUndefined()
    console.log('  destroy + label check ok')
  }, 300_000)

  it('get() throws SandboxNotFoundError for a non-existent id', async () => {
    await expect(provider.get('sb-this-id-does-not-exist')).rejects.toThrow(SandboxNotFoundError)
  })

  it('destroy is idempotent — double destroy does not throw', async () => {
    await expect(provider.destroy('sb-this-id-does-not-exist')).resolves.toBeUndefined()
  })
})
