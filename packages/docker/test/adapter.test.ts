import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecTimeoutError, ProviderError, SandboxNotFoundError } from '@sandbank.dev/core'
import { DockerAdapter } from '../src/adapter.js'
import type { DockerCli, DockerRunOptions, DockerRunResult } from '../src/cli.js'

const encoder = new TextEncoder()

function ok(stdout = ''): DockerRunResult {
  return { exitCode: 0, stdout: encoder.encode(stdout), stderr: '', timedOut: false }
}

function fail(stderr: string, exitCode = 1): DockerRunResult {
  return { exitCode, stdout: new Uint8Array(), stderr, timedOut: false }
}

function inspectJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([{
    Id: 'abcdef1234567890',
    Created: '2026-10-15T12:00:00.123456789Z',
    Config: { Image: 'ubuntu:24.04', Labels: { 'sandbank.managed': 'true' } },
    State: { Status: 'running' },
    Mounts: [],
    ...overrides,
  }])
}

function fakeCli(handler: (args: string[], options?: DockerRunOptions) => DockerRunResult) {
  const calls: Array<{ args: string[]; options?: DockerRunOptions }> = []
  const cli: DockerCli = {
    run: vi.fn(async (args, options) => {
      calls.push({ args, options })
      return handler(args, options)
    }),
    stream: vi.fn(() => new ReadableStream<Uint8Array>()),
  }
  return { cli, calls }
}

/** Default daemon: run returns an id, inspect returns one managed running container. */
function daemon(overrides: Partial<Record<string, (args: string[]) => DockerRunResult>> = {}) {
  return fakeCli((args) => {
    const handler = overrides[args[0]!]
    if (handler) return handler(args)
    if (args[0] === 'run') return ok('abcdef1234567890\n')
    if (args[0] === 'container' && args[1] === 'inspect') return ok(inspectJson())
    return ok()
  })
}

describe('DockerAdapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('declares its capabilities', () => {
    const adapter = new DockerAdapter({}, daemon().cli)
    expect(adapter.name).toBe('docker')
    expect([...adapter.capabilities].sort()).toEqual(['exec.stream', 'port.expose', 'sleep', 'volumes'])
  })

  describe('createSandbox', () => {
    it('runs a labeled long-lived container and keeps env values out of argv', async () => {
      const { cli, calls } = daemon()
      const sandbox = await new DockerAdapter({}, cli).createSandbox({
        image: 'node:22',
        env: { TOKEN: 'secret-value' },
        resources: { cpu: 2, memory: 512 },
        ports: [[8080, 3000]],
        volumes: [{ id: 'data', mountPath: '/data' }],
      })

      const run = calls[0]!
      expect(run.args).toEqual([
        'run', '-d', '--init', '--label', 'sandbank.managed=true',
        '-e', 'TOKEN',
        '--cpus', '2', '--memory', '512m',
        '-p', '127.0.0.1:8080:3000',
        '-v', 'data:/data',
        '--entrypoint', 'tail', 'node:22', '-f', '/dev/null',
      ])
      expect(run.args.join(' ')).not.toContain('secret-value')
      expect(run.options?.env).toEqual({ TOKEN: 'secret-value' })

      expect(sandbox.id).toBe('abcdef123456')
      expect(sandbox.state).toBe('running')
      expect(sandbox.createdAt).toBe('2026-10-15T12:00:00.123Z')
    })

    it('uses --rm with a sleep entrypoint for autoDestroyMinutes', async () => {
      const { cli, calls } = daemon()
      await new DockerAdapter({ defaultImage: 'alpine:3.20', runArgs: ['--gpus', 'all'] }, cli)
        .createSandbox({ autoDestroyMinutes: 2 })
      expect(calls[0]!.args).toEqual([
        'run', '-d', '--init', '--label', 'sandbank.managed=true', '--rm',
        '--gpus', 'all',
        '--entrypoint', 'sleep', 'alpine:3.20', '120',
      ])
    })

    it('wraps docker failures in ProviderError', async () => {
      const { cli } = daemon({ run: () => fail('Unable to find image') })
      const err = await new DockerAdapter({}, cli).createSandbox({}).catch(e => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect(err.message).toContain('Unable to find image')
    })

    it('wraps a missing docker binary in ProviderError', async () => {
      const cli: DockerCli = {
        run: vi.fn().mockRejectedValue(new Error('spawn docker ENOENT')),
        stream: vi.fn(),
      }
      await expect(new DockerAdapter({}, cli).createSandbox({})).rejects.toBeInstanceOf(ProviderError)
    })
  })

  describe('getSandbox', () => {
    it('throws SandboxNotFoundError for a missing container', async () => {
      const { cli } = daemon({ container: () => fail('Error: No such container: nope') })
      const err = await new DockerAdapter({}, cli).getSandbox('nope').catch(e => e)
      expect(err).toBeInstanceOf(SandboxNotFoundError)
      expect(err.sandboxId).toBe('nope')
    })

    it('refuses containers sandbank did not create', async () => {
      const { cli } = daemon({ container: () => ok(inspectJson({ Config: { Image: 'x', Labels: {} } })) })
      await expect(new DockerAdapter({}, cli).getSandbox('other')).rejects.toBeInstanceOf(SandboxNotFoundError)
    })

    it.each([
      ['paused', 'stopped'],
      ['exited', 'stopped'],
      ['created', 'creating'],
      ['dead', 'terminated'],
    ])('maps docker status %s to %s', async (status, expected) => {
      const { cli } = daemon({ container: () => ok(inspectJson({ State: { Status: status } })) })
      expect((await new DockerAdapter({}, cli).getSandbox('abc')).state).toBe(expected)
    })
  })

  describe('sandbox operations', () => {
    async function sandboxWith(overrides: Parameters<typeof daemon>[0]) {
      const fake = daemon(overrides)
      const sandbox = await new DockerAdapter({ publicHost: 'host.test' }, fake.cli).getSandbox('abcdef123456')
      fake.calls.length = 0
      return { sandbox, calls: fake.calls, cli: fake.cli }
    }

    it('exec runs sh -c with cwd and returns the exit code', async () => {
      const { sandbox, calls } = await sandboxWith({
        exec: () => ({ exitCode: 3, stdout: encoder.encode('out'), stderr: 'err', timedOut: false }),
      })
      expect(await sandbox.exec('false', { cwd: '/w', timeout: 5000 })).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' })
      expect(calls[0]!.args).toEqual(['exec', '-w', '/w', 'abcdef123456', 'sh', '-c', 'false'])
      expect(calls[0]!.options).toEqual({ timeoutMs: 5000 })
    })

    it('exec raises ExecTimeoutError on timeout', async () => {
      const { sandbox } = await sandboxWith({
        exec: () => ({ exitCode: -1, stdout: new Uint8Array(), stderr: '', timedOut: true }),
      })
      await expect(sandbox.exec('sleep 9', { timeout: 10 })).rejects.toBeInstanceOf(ExecTimeoutError)
    })

    it('exec raises SandboxNotFoundError when the container is gone', async () => {
      const { sandbox } = await sandboxWith({ exec: () => fail('Error response from daemon: No such container: abc') })
      await expect(sandbox.exec('true')).rejects.toBeInstanceOf(SandboxNotFoundError)
    })

    it('writeFile pipes bytes over stdin and never puts content in argv', async () => {
      const { sandbox, calls } = await sandboxWith({})
      await sandbox.writeFile!('/tmp/a b.txt', 'hello')
      expect(calls[0]!.args).toEqual([
        'exec', '-i', 'abcdef123456', 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', '/tmp/a b.txt',
      ])
      expect(new TextDecoder().decode(calls[0]!.options!.input)).toBe('hello')
    })

    it('readFile returns raw bytes and fails on a missing file', async () => {
      const bytes = new Uint8Array([0, 255, 10])
      const { sandbox } = await sandboxWith({
        exec: (args) => args.at(-1) === '/missing'
          ? fail('cat: /missing: No such file or directory')
          : { exitCode: 0, stdout: bytes, stderr: '', timedOut: false },
      })
      expect(await sandbox.readFile!('/bin.dat')).toEqual(bytes)
      await expect(sandbox.readFile!('/missing')).rejects.toBeInstanceOf(ProviderError)
    })

    it('sleep and wake pause and unpause', async () => {
      const { sandbox, calls } = await sandboxWith({})
      await sandbox.sleep!()
      expect(sandbox.state).toBe('stopped')
      await sandbox.wake!()
      expect(sandbox.state).toBe('running')
      expect(calls.map(c => c.args)).toEqual([['pause', 'abcdef123456'], ['unpause', 'abcdef123456']])
    })

    it('exposePort returns the published host port', async () => {
      const { sandbox } = await sandboxWith({ port: () => ok('0.0.0.0:49153\n[::]:49153\n') })
      expect(await sandbox.exposePort!(3000)).toEqual({ url: 'http://host.test:49153' })
    })

    it('exposePort explains how to publish an unpublished port', async () => {
      const { sandbox } = await sandboxWith({ port: () => fail('Error: No public port') })
      await expect(sandbox.exposePort!(3000)).rejects.toThrow(/ports: \[\[hostPort, 3000\]\]/)
    })

    it('execStream delegates to the streaming CLI', async () => {
      const { sandbox, cli } = await sandboxWith({})
      await sandbox.execStream!('ls', { cwd: '/' })
      expect(cli.stream).toHaveBeenCalledWith(['exec', '-w', '/', 'abcdef123456', 'sh', '-c', 'ls'])
    })
  })

  describe('listSandboxes', () => {
    function listDaemon() {
      return daemon({
        ps: () => ok('aaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbb\n'),
        container: () => ok(JSON.stringify([
          { Id: 'aaaaaaaaaaaaaaaa', Created: '2026-10-15T00:00:00Z', Config: { Image: 'a' }, State: { Status: 'running' } },
          { Id: 'bbbbbbbbbbbbbbbb', Created: '2026-10-15T00:00:00Z', Config: { Image: 'b' }, State: { Status: 'paused' } },
        ])),
      })
    }

    it('lists managed containers', async () => {
      const { cli, calls } = listDaemon()
      const list = await new DockerAdapter({}, cli).listSandboxes()
      expect(calls[0]!.args).toEqual(['ps', '-aq', '--no-trunc', '--filter', 'label=sandbank.managed=true'])
      expect(list.map(s => [s.id, s.state, s.image])).toEqual([
        ['aaaaaaaaaaaa', 'running', 'a'],
        ['bbbbbbbbbbbb', 'stopped', 'b'],
      ])
    })

    it('filters by state and limit', async () => {
      expect((await new DockerAdapter({}, listDaemon().cli).listSandboxes({ state: 'stopped' })).map(s => s.id))
        .toEqual(['bbbbbbbbbbbb'])
      expect(await new DockerAdapter({}, listDaemon().cli).listSandboxes({ limit: 1 })).toHaveLength(1)
    })

    it('returns [] without calling inspect when nothing is managed', async () => {
      const { cli, calls } = daemon({ ps: () => ok('') })
      expect(await new DockerAdapter({}, cli).listSandboxes()).toEqual([])
      expect(calls).toHaveLength(1)
    })
  })

  describe('destroySandbox', () => {
    it('force-removes the container with its anonymous volumes', async () => {
      const { cli, calls } = daemon()
      await new DockerAdapter({}, cli).destroySandbox('abc')
      expect(calls[0]!.args).toEqual(['rm', '-f', '-v', 'abc'])
    })

    it('is idempotent', async () => {
      const { cli } = daemon({ rm: () => fail('Error: No such container: abc') })
      await expect(new DockerAdapter({}, cli).destroySandbox('abc')).resolves.toBeUndefined()
    })

    it('surfaces other failures', async () => {
      const { cli } = daemon({ rm: () => fail('permission denied') })
      await expect(new DockerAdapter({}, cli).destroySandbox('abc')).rejects.toBeInstanceOf(ProviderError)
    })
  })

  describe('volumes', () => {
    it('creates labeled volumes', async () => {
      const { cli, calls } = daemon({ volume: () => ok('data\n') })
      expect(await new DockerAdapter({}, cli).createVolume({ name: 'data', sizeGB: 5 }))
        .toEqual({ id: 'data', name: 'data', sizeGB: 5, attachedTo: null })
      expect(calls[0]!.args).toEqual(['volume', 'create', '--label', 'sandbank.managed=true', 'data'])
    })

    it('deletes idempotently', async () => {
      const { cli } = daemon({ volume: () => fail('Error: No such volume: data') })
      await expect(new DockerAdapter({}, cli).deleteVolume('data')).resolves.toBeUndefined()
    })

    it('reports which sandbox a volume is attached to', async () => {
      const { cli } = daemon({
        volume: () => ok('data\nspare\n'),
        ps: () => ok('aaaaaaaaaaaaaaaa\n'),
        container: () => ok(JSON.stringify([{
          Id: 'aaaaaaaaaaaaaaaa', Created: '2026-10-15T00:00:00Z', Config: { Image: 'a' }, State: { Status: 'running' },
          Mounts: [{ Type: 'volume', Name: 'data' }, { Type: 'bind' }],
        }])),
      })
      expect(await new DockerAdapter({}, cli).listVolumes()).toEqual([
        { id: 'data', name: 'data', sizeGB: 0, attachedTo: 'aaaaaaaaaaaa' },
        { id: 'spare', name: 'spare', sizeGB: 0, attachedTo: null },
      ])
    })
  })
})
