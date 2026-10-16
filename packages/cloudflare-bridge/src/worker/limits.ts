/** Hard safety limits. Cloudflare has no spending cap, so these are the cap. */
export const MAX_SANDBOXES = 3
export const DEFAULT_LIFETIME_MIN = 30
export const MAX_LIFETIME_MIN = 60
/** Container idle sleep; must stay <= 5 minutes. */
export const SLEEP_AFTER = '5m'
/** No alarm or schedule may be set further out than this. */
export const MAX_ALARM_HORIZON_S = 3600
export const MAX_EXEC_TIMEOUT_MS = 300_000
export const MAX_BODY_BYTES = 8 * 1024 * 1024
