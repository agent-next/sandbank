import type { WorkspaceCapabilities } from '@sandbank.dev/workspace'

export type Db9BackendCapabilityStatus =
  | 'native'
  | 'emulated'
  | 'requires-extension'
  | 'unsupported'
  | 'planned'

export type Db9BackendCapabilityName =
  | 'files'
  | 'readonlySql'
  | 'writeSql'
  | 'branch'
  | 'checkpoint'
  | 'diff'
  | 'rollback'
  | 'watch'
  | 'auditLog'
  | 'ftsSearch'
  | 'vectorSearch'
  | 'functionRuntime'
  | 'scopedToken'
  | 'fileAsTable'

export interface Db9BackendCapability {
  name: Db9BackendCapabilityName
  workspaceCapability?: keyof WorkspaceCapabilities
  db9: Db9BackendCapabilityStatus
  postgres: Db9BackendCapabilityStatus
  description: string
}

export type Db9BackendCapabilityMap = Record<Db9BackendCapabilityName, boolean>

export const DB9_BACKEND_CAPABILITY_MATRIX: Db9BackendCapability[] = [
  {
    name: 'files',
    workspaceCapability: 'read',
    db9: 'requires-extension',
    postgres: 'emulated',
    description: 'Workspace file objects backed by fs9 tables or a compatible file table.',
  },
  {
    name: 'readonlySql',
    workspaceCapability: 'sqlQuery',
    db9: 'native',
    postgres: 'native',
    description: 'Safe SELECT/WITH/EXPLAIN gateway for agent inspection.',
  },
  {
    name: 'writeSql',
    workspaceCapability: 'sqlQuery',
    db9: 'native',
    postgres: 'native',
    description: 'Direct SQL writes; Sandbank App Kernel should route this through proposals and approval.',
  },
  {
    name: 'branch',
    workspaceCapability: 'branch',
    db9: 'native',
    postgres: 'planned',
    description: 'Create isolated write branches before applying user-visible changes.',
  },
  {
    name: 'checkpoint',
    workspaceCapability: 'checkpoint',
    db9: 'emulated',
    postgres: 'emulated',
    description: 'Snapshot state before a run or proposal.',
  },
  {
    name: 'diff',
    workspaceCapability: 'diff',
    db9: 'emulated',
    postgres: 'emulated',
    description: 'Compare checkpoint or branch contents for approval review.',
  },
  {
    name: 'rollback',
    workspaceCapability: 'rollback',
    db9: 'emulated',
    postgres: 'emulated',
    description: 'Restore a previous checkpoint.',
  },
  {
    name: 'watch',
    workspaceCapability: 'watch',
    db9: 'native',
    postgres: 'planned',
    description: 'Observe agent-visible data changes.',
  },
  {
    name: 'auditLog',
    workspaceCapability: 'log',
    db9: 'emulated',
    postgres: 'emulated',
    description: 'Append-only operation log for authorization, approvals, and capability calls.',
  },
  {
    name: 'ftsSearch',
    workspaceCapability: 'query',
    db9: 'requires-extension',
    postgres: 'native',
    description: 'Full-text search over workspace data.',
  },
  {
    name: 'vectorSearch',
    workspaceCapability: 'vectorSearch',
    db9: 'requires-extension',
    postgres: 'requires-extension',
    description: 'Vector retrieval for memory and domain records.',
  },
  {
    name: 'functionRuntime',
    workspaceCapability: 'functionRuntime',
    db9: 'native',
    postgres: 'planned',
    description: 'Database-hosted function execution with scoped fs9/data access.',
  },
  {
    name: 'scopedToken',
    db9: 'native',
    postgres: 'planned',
    description: 'Mint short-lived database tokens from Sandbank capability grants.',
  },
  {
    name: 'fileAsTable',
    workspaceCapability: 'fileAsTable',
    db9: 'requires-extension',
    postgres: 'emulated',
    description: 'Expose file entries as queryable relational data.',
  },
]

export const DB9_DEFAULT_BACKEND_CAPABILITIES: Db9BackendCapabilityMap = Object.freeze({
  files: true,
  readonlySql: true,
  writeSql: true,
  branch: true,
  checkpoint: true,
  diff: true,
  rollback: true,
  watch: true,
  auditLog: true,
  ftsSearch: true,
  vectorSearch: true,
  functionRuntime: true,
  scopedToken: true,
  fileAsTable: true,
})

export function workspaceCapabilitiesToDb9BackendCapabilities(
  capabilities: WorkspaceCapabilities,
): Db9BackendCapabilityMap {
  return {
    files: capabilities.read && capabilities.write && capabilities.list,
    readonlySql: Boolean(capabilities.sqlQuery),
    writeSql: Boolean(capabilities.sqlQuery),
    branch: Boolean(capabilities.branch),
    checkpoint: capabilities.checkpoint,
    diff: capabilities.diff,
    rollback: capabilities.rollback,
    watch: capabilities.watch,
    auditLog: capabilities.log,
    ftsSearch: capabilities.query,
    vectorSearch: Boolean(capabilities.vectorSearch),
    functionRuntime: Boolean(capabilities.functionRuntime),
    scopedToken: capabilities.provider?.['scopedToken'] !== undefined && capabilities.provider['scopedToken'] !== 'unsupported',
    fileAsTable: Boolean(capabilities.fileAsTable),
  }
}

export function missingDb9BackendCapabilities(
  actual: Db9BackendCapabilityMap,
  required: Iterable<Db9BackendCapabilityName>,
): Db9BackendCapabilityName[] {
  return [...required].filter(name => !actual[name])
}

export function assertDb9BackendCapabilities(
  actual: Db9BackendCapabilityMap,
  required: Iterable<Db9BackendCapabilityName>,
): void {
  const missing = missingDb9BackendCapabilities(actual, required)
  if (missing.length > 0) {
    throw new Error(`Missing DB9 backend capabilities: ${missing.join(', ')}`)
  }
}
