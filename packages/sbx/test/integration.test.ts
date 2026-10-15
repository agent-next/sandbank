/**
 * SbxAdapter integration tests against a real sbx endpoint.
 *
 * Runs only when SBX_API_KEY is set (SBX_DOMAIN optional). Creates one
 * sandbox with a 10-minute lifetime and destroys it at the end.
 */
import { describe, expect, it } from 'vitest'
import { createProvider, withPortExpose, withSleep } from '@sandbank.dev/core'
import { SbxAdapter } from '../src/adapter.js'

describe.skipIf(!process.env.SBX_API_KEY)('SbxAdapter (real sbx)', () => {
  it('runs the core lifecycle', async () => {
    const provider = createProvider(new SbxAdapter({ autoDestroyMinutes: 10 }))
    const sandbox = await provider.create({})
    try {
      expect(await sandbox.exec('echo hello-sbx')).toEqual({ exitCode: 0, stdout: 'hello-sbx\n', stderr: '' })

      const bytes = new Uint8Array(64 * 1024).map((_, i) => i % 251)
      await sandbox.writeFile('/home/user/blob.bin', bytes)
      expect(await sandbox.readFile('/home/user/blob.bin')).toEqual(bytes)

      expect((await provider.list()).map(s => s.id)).toContain(sandbox.id)
      expect((await withPortExpose(sandbox)!.exposePort(8000)).url).toContain(`8000-${sandbox.id}.`)

      const sleepable = withSleep(sandbox)!
      await sleepable.sleep()
      await sleepable.wake()
      expect((await sandbox.exec('echo awake')).stdout).toBe('awake\n')
    } finally {
      await provider.destroy(sandbox.id)
    }
    expect((await provider.list()).map(s => s.id)).not.toContain(sandbox.id)
  })
})
