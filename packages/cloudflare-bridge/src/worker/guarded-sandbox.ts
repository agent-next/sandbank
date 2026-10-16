import { Sandbox as BaseSandbox } from '@cloudflare/sandbox'
import { clampSchedule, guardedAlarm, isDrain, type DrainEnv } from './alarm-guard.js'
import { SLEEP_AFTER } from './limits.js'

/** Sandbox Durable Object with the safety rails: short sleep, clamped schedules, kill switch, non-throwing alarm. */
export class Sandbox extends BaseSandbox<DrainEnv> {
  sleepAfter = SLEEP_AFTER

  override async schedule<T = string>(when: Date | number, callback: string, payload?: T) {
    return super.schedule(clampSchedule(when), callback, payload)
  }

  override async alarm(props: { isRetry: boolean; retryCount: number }): Promise<void> {
    await guardedAlarm({
      drain: isDrain(this.env),
      deleteAlarm: () => this.ctx.storage.deleteAlarm(),
      run: () => super.alarm(props),
      stop: () => this.destroy(),
      log: (msg, err) => console.error(msg, err),
    })
  }
}
