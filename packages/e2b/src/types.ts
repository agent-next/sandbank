export interface E2BAdapterConfig {
  /** E2B API key. Defaults to E2B_API_KEY when omitted. */
  apiKey?: string

  /** E2B API domain. Defaults to the SDK default. */
  domain?: string

  /** E2B API URL. Defaults to E2B_API_URL or `https://api.${domain}`. */
  apiUrl?: string

  /** Request timeout in milliseconds for SDK API calls. */
  requestTimeoutMs?: number

  /** Default sandbox template or ID. Defaults to E2B's base template. */
  template?: string

  /** Default sandbox timeout in milliseconds. E2B applies its SDK default when omitted. */
  defaultTimeoutMs?: number

  /** Enable SDK debug mode. */
  debug?: boolean
}
