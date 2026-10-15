import { spawn } from 'node:child_process'

export interface DockerRunResult {
  exitCode: number
  stdout: Uint8Array
  stderr: string
  timedOut: boolean
}

export interface DockerRunOptions {
  input?: Uint8Array
  timeoutMs?: number
  /** Extra environment for the docker process (used for `-e NAME` passthrough). */
  env?: Record<string, string>
}

/** Runs the docker CLI. Injectable so tests can stand in for a daemon. */
export interface DockerCli {
  run(args: string[], options?: DockerRunOptions): Promise<DockerRunResult>
  stream(args: string[]): ReadableStream<Uint8Array>
}

export function createDockerCli(binary = 'docker'): DockerCli {
  return {
    run(args, options) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: options?.env ? { ...process.env, ...options.env } : process.env,
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let timedOut = false
        const timer = options?.timeoutMs
          ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
          : undefined

        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', (err) => { clearTimeout(timer); reject(err) })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({
            exitCode: code ?? -1,
            stdout: new Uint8Array(Buffer.concat(stdout)),
            stderr: Buffer.concat(stderr).toString('utf8'),
            timedOut,
          })
        })
        child.stdin.end(options?.input)
      })
    },

    stream(args) {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      return new ReadableStream<Uint8Array>({
        start(controller) {
          let open = 2
          const done = () => { if (--open === 0) controller.close() }
          for (const source of [child.stdout, child.stderr]) {
            source.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
            source.on('end', done)
          }
          child.on('error', err => controller.error(err))
        },
        cancel() { child.kill('SIGKILL') },
      })
    },
  }
}
