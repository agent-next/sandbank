export interface SbxAdapterConfig {
  /** sbx API key. Defaults to SBX_API_KEY, then E2B_API_KEY. */
  apiKey?: string

  /** sbx base domain. Defaults to SBX_DOMAIN, then `sbx.agent-next.com`. */
  domain?: string

  /** sbx API URL. Defaults to `https://api.${domain}`. */
  apiUrl?: string

  /** Request timeout in milliseconds for API calls. */
  requestTimeoutMs?: number

  /** Default template when `image` is omitted. */
  template?: string

  /**
   * Sandbox lifetime in minutes when `autoDestroyMinutes` is not set on create.
   * Defaults to 60. sbx sandboxes are killed, not paused, when it runs out.
   */
  autoDestroyMinutes?: number
}
