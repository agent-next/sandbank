/**
 * DockerAdapter integration tests against a real Docker daemon.
 *
 * Opt in with DOCKER_INTEGRATION=1 (needs the docker CLI and a daemon).
 * Image: DOCKER_TEST_IMAGE, default alpine:3.20.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  createProvider,
  SandboxNotFoundError,
  withPortExpose,
  withSleep,
  withStreaming,
  withVolumes,
} from '@sandbank.dev/core'
import type { Sandbox } from '@sandbank.dev/core'
import { DockerAdapter } from '../src/adapter.js'

const enabled = process.env.DOCKER_INTEGRATION === '1'
const image = process.env.DOCKER_TEST_IMAGE ?? 'alpine:3.20'

describe.skipIf(!enabled)('DockerAdapter (real daemon)', () => {
  const provider = createProvider(new DockerAdapter({ defaultImage: image }))
  const created: string[] = []
  const volumes: string[] = []

  async function create(config: Parameters<typeof provider.create>[0] = {}): Promise<Sandbox> {
    const sandbox = await provider.create(config)
    created.push(sandbox.id)
    return sandbox
  }

  afterAll(async () => {
    for (const id of created) await provider.destroy(id).catch(() => {})
    const vp = withVolumes(provider)
    for (const name of volumes) await vp?.deleteVolume(name).catch(() => {})
  })

  it('creates, execs, lists and destroys', async () => {
    const sandbox = await create({ env: { GREETING: 'hi there' } })
    expect(sandbox.state).toBe('running')

    const result = await sandbox.exec('echo "$GREETING"; echo oops >&2; exit 7')
    expect(result).toEqual({ exitCode: 7, stdout: 'hi there\n', stderr: 'oops\n' })
    expect((await sandbox.exec('pwd', { cwd: '/tmp' })).stdout.trim()).toBe('/tmp')

    const listed = await provider.list({ state: 'running' })
    expect(listed.map(s => s.id)).toContain(sandbox.id)

    await provider.destroy(sandbox.id)
    await provider.destroy(sandbox.id)
    await expect(provider.get(sandbox.id)).rejects.toBeInstanceOf(SandboxNotFoundError)
  })

  it('round-trips binary files and archives', async () => {
    const sandbox = await create()
    const bytes = new Uint8Array(256 * 1024).map((_, i) => (i * 31) % 256)
    await sandbox.writeFile('/work/nested/blob.bin', bytes)
    expect(await sandbox.readFile('/work/nested/blob.bin')).toEqual(bytes)
    expect((await sandbox.exec('wc -c < /work/nested/blob.bin')).stdout.trim()).toBe(String(bytes.length))

    const archive = await sandbox.downloadArchive('/work')
    const other = await create()
    await other.uploadArchive(archive, '/restore')
    expect((await other.exec('find /restore -name blob.bin | head -1 | xargs wc -c')).stdout).toContain(String(bytes.length))
  })

  it('pauses and resumes', async () => {
    const sandbox = await create()
    const sleepable = withSleep(sandbox)!
    await sleepable.sleep()
    expect((await provider.get(sandbox.id)).state).toBe('stopped')
    await sleepable.wake()
    expect((await sandbox.exec('echo awake')).stdout).toBe('awake\n')
  })

  it('streams exec output', async () => {
    const sandbox = withStreaming(await create())!
    const text = await new Response(await sandbox.execStream('for i in 1 2 3; do echo $i; done')).text()
    expect(text).toBe('1\n2\n3\n')
  })

  it('exposes a published port', async () => {
    const sandbox = withPortExpose(await create({ ports: [[0, 8000]] }))!
    await sandbox.exec(
      `nohup sh -c 'while :; do printf "HTTP/1.0 200 OK\\r\\nContent-Length: 3\\r\\n\\r\\nok\\n" | nc -l -p 8000; done' >/dev/null 2>&1 &`,
    )
    const { url } = await sandbox.exposePort(8000)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    let body = ''
    for (let i = 0; i < 20 && !body; i++) {
      body = await fetch(url).then(r => r.text()).catch(() => '')
      if (!body) await new Promise(r => setTimeout(r, 250))
    }
    expect(body).toBe('ok\n')
  })

  it('persists data in a volume across sandboxes', async () => {
    const vp = withVolumes(provider)!
    const name = `sandbank-it-${Date.now()}`
    const volume = await vp.createVolume({ name })
    volumes.push(volume.id)

    const writer = await create({ volumes: [{ id: volume.id, mountPath: '/data' }] })
    await writer.exec('echo persisted > /data/state.txt')
    expect((await vp.listVolumes()).find(v => v.id === name)?.attachedTo).toBe(writer.id)
    await provider.destroy(writer.id)

    const reader = await create({ volumes: [{ id: volume.id, mountPath: '/data' }] })
    expect((await reader.exec('cat /data/state.txt')).stdout).toBe('persisted\n')
  })

  it('removes itself after autoDestroyMinutes', async () => {
    const sandbox = await create({ autoDestroyMinutes: 0.02 })
    await new Promise(r => setTimeout(r, 4000))
    await expect(provider.get(sandbox.id)).rejects.toBeInstanceOf(SandboxNotFoundError)
  })
})
