import { getSandbox } from '@cloudflare/sandbox'
import { isDrain } from './alarm-guard.js'
import { handle, reap, type Backend, type BridgeDeps } from './handler.js'
import { Sandbox } from './guarded-sandbox.js'
import { SandboxRegistry } from './registry-do.js'

export { Sandbox, SandboxRegistry }

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>
  REGISTRY: DurableObjectNamespace<SandboxRegistry>
  BRIDGE_TOKEN?: string
  DRAIN?: string
  PREVIEW_HOSTNAME?: string
}

function deps(env: Env): BridgeDeps {
  const sb = (id: string) => getSandbox(env.Sandbox, id)
  const backend: Backend = {
    async create(id, vars) {
      if (vars && Object.keys(vars).length > 0) await sb(id).setEnvVars(vars)
    },
    async exec(id, command, { cwd, timeoutMs }) {
      const r = await sb(id).exec(command, { cwd, timeout: timeoutMs })
      return { exitCode: r.exitCode ?? (r.success ? 0 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    async readFile(id, path) {
      const r = await sb(id).readFile(path, { encoding: 'base64' })
      return typeof r === 'string' ? r : (r as { content: string }).content
    },
    async writeFile(id, path, contentBase64) {
      await sb(id).writeFile(path, contentBase64, { encoding: 'base64' })
    },
    async exposePort(id, port) {
      const r = await sb(id).exposePort(port, { hostname: env.PREVIEW_HOSTNAME! })
      return { url: r.url }
    },
    async destroy(id) {
      await sb(id).destroy()
    },
  }
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
  return {
    env,
    backend,
    registry: {
      reserve: (i, m, n) => reg.reserve(i, m, n),
      list: () => reg.list(),
      expire: (i, at) => reg.expire(i, at),
      release: (i) => reg.release(i),
    },
    now: () => Date.now(),
    newId: () => `cf-${crypto.randomUUID().slice(0, 8)}`,
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, deps(env)),
  // Cron: destroy expired sandboxes; when draining, destroy every sandbox.
  async scheduled(_event: ScheduledController, env: Env) {
    await reap(deps(env), isDrain(env))
  },
}
