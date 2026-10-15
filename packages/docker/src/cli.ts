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
}

export interface DockerStreamOptions {
  /** Called when the consumer cancels, after the local docker client is killed. */
  onCancel?: () => void
}

/** Runs the docker CLI. Injectable so tests can stand in for a daemon. */
export interface DockerCli {
  run(args: string[], options?: DockerRunOptions): Promise<DockerRunResult>
  stream(args: string[], options?: DockerStreamOptions): ReadableStream<Uint8Array>
}

export function createDockerCli(binary = 'docker'): DockerCli {
  return {
    run(args, options) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
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

    stream(args, options) {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let finished = false
      return new ReadableStream<Uint8Array>({
        start(controller) {
          let open = 2
          for (const source of [child.stdout, child.stderr]) {
            source.on('data', (chunk: Buffer) => { if (!finished) controller.enqueue(new Uint8Array(chunk)) })
            source.on('end', () => {
              if (--open === 0 && !finished) { finished = true; controller.close() }
            })
          }
          child.on('error', (err) => {
            if (!finished) { finished = true; controller.error(err) }
          })
        },
        cancel() {
          finished = true
          child.kill('SIGKILL')
          options?.onCancel?.()
        },
      })
    },
  }
}
