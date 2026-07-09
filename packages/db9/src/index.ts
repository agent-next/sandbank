// Adapter
export { Db9ServiceAdapter } from './adapter.js'
export type { Db9AdapterConfig } from './adapter.js'
export { Db9WorkspaceAdapter } from './workspace-adapter.js'
export type {
  Db9BranchManager,
  Db9FunctionInvoker,
  Db9ScopedTokenIssuer,
  Db9SearchOptions,
  Db9SqlExecutor,
  Db9WatchTransport,
  Db9WorkspaceAdapterConfig,
  Db9WorkspaceClient,
} from './workspace-adapter.js'

// Client
export { Db9Client } from './client.js'
export type { Db9ClientConfig } from './client.js'

// Skill
export { fetchDb9Skill, db9SkillDefinition, clearSkillCache } from './skill.js'

// Brain
export { BRAIN_SCHEMA, initBrainSchema } from './brain.js'
export { BRAIN_SKILL, brainSkillDefinition } from './brain-skill.js'

// Convenience
export { createDb9Service, createDb9Brain } from './convenience.js'

// Observer
export { EVENTS_SCHEMA, createDb9Observer } from './db9-observer.js'

// Backend capability matrix
export {
  DB9_BACKEND_CAPABILITY_MATRIX,
  DB9_DEFAULT_BACKEND_CAPABILITIES,
  assertDb9BackendCapabilities,
  missingDb9BackendCapabilities,
  workspaceCapabilitiesToDb9BackendCapabilities,
} from './backend-capabilities.js'
export type {
  Db9BackendCapability,
  Db9BackendCapabilityMap,
  Db9BackendCapabilityName,
  Db9BackendCapabilityStatus,
} from './backend-capabilities.js'

// Types
export type {
  Db9ApiError,
  Db9Database,
  Db9FunctionInvokeOptions,
  Db9FunctionInvokeResult,
  Db9ScopedToken,
  Db9ScopedTokenRequest,
  Db9SqlResult,
} from './types.js'
