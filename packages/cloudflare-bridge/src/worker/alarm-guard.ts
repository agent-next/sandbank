import { MAX_ALARM_HORIZON_S } from './limits.js'

export interface DrainEnv {
  DRAIN?: string
}

/** Kill switch: DRAIN=1 (or "true") turns the Worker and every alarm off. */
export function isDrain(env: DrainEnv): boolean {
  return env.DRAIN === '1' || env.DRAIN === 'true'
}

/**
 * Clamp a `schedule()` argument. @cloudflare/containers treats a number as
 * SECONDS from now (not epoch milliseconds); passing Date.now() there once
 * produced an alarm past year 2189 and an endless retry loop. Anything
 * non-finite, negative or beyond the horizon is pulled into [0, 1h].
 */
export function clampSchedule(when: Date | number, nowMs = Date.now()): Date | number {
  if (when instanceof Date) {
    const t = when.getTime()
    if (!Number.isFinite(t)) return new Date(nowMs + MAX_ALARM_HORIZON_S * 1000)
    return new Date(Math.min(Math.max(t, nowMs), nowMs + MAX_ALARM_HORIZON_S * 1000))
  }
  if (!Number.isFinite(when)) return MAX_ALARM_HORIZON_S
  return Math.min(Math.max(when, 0), MAX_ALARM_HORIZON_S)
}

export interface GuardedAlarmOptions {
  drain: boolean
  deleteAlarm: () => Promise<void>
  /** The wrapped library alarm handler. */
  run: () => Promise<void>
  /** Stop the container; best effort. */
  stop: () => Promise<void>
  log?: (msg: string, err?: unknown) => void
}

/**
 * Alarm wrapper: never throws out, never reschedules while draining.
 * On drain or failure the container is stopped and the alarm deleted ("parked"),
 * so a broken alarm cannot retry forever.
 */
export async function guardedAlarm(o: GuardedAlarmOptions): Promise<void> {
  const park = async () => {
    await o.stop().catch(() => {})
    await o.deleteAlarm().catch(() => {})
  }
  if (o.drain) {
    await park()
    return
  }
  try {
    await o.run()
  } catch (err) {
    o.log?.('alarm failed; parking', err)
    await park()
  }
}
