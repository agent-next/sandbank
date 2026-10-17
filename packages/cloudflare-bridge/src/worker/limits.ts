/** Hard safety limits. Cloudflare has no spending cap, so these are the cap. */
/** Sized for an agent fleet (one Claude Code worker per sandbox); 256 x standard-1 = 128 vCPU,
 * well inside the account limit of 1,500 concurrent vCPU. */
export const MAX_SANDBOXES = 256
export const DEFAULT_LIFETIME_MIN = 30
export const MAX_LIFETIME_MIN = 60
/** Container idle sleep; must stay <= 5 minutes. */
export const SLEEP_AFTER = '5m'
/** No alarm or schedule may be set further out than this. */
export const MAX_ALARM_HORIZON_S = 3600
export const MAX_EXEC_TIMEOUT_MS = 300_000
/** A create whose container has not started by then is undone (503 provisioning, client retries):
 * at 256 parallel creates some cold starts took > 5 min and outlived the caller. */
export const CREATE_TIMEOUT_MS = 90_000
/** A timed-out create keeps its slot this long, then the reaper destroys whatever came up (cold starts
 * of up to ~5.5 min were seen), so a late container is never orphaned. */
export const PROVISIONING_REAP_MS = 10 * 60_000
export const MAX_BODY_BYTES = 8 * 1024 * 1024
