/** Wire shapes of the bridge HTTP API (shared by the Worker and the client). */
export interface BridgeSandboxInfo {
  id: string
  state: 'running'
  createdAt: string
  expiresAt: string
}
