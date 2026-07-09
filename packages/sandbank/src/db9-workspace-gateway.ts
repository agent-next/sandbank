import {
  WorkspaceError,
  type AgentOp,
  type Checkpoint,
  type QueryResult,
  type WorkspaceAdapter,
  type WorkspaceEntry,
  type WorkspaceData,
} from '@sandbank.dev/workspace'

export type SandbankWorkspaceGatewayHost =
  | 'web'
  | 'codex'
  | 'cloud_code'
  | 'mcp'
  | 'cli'
  | 'worker'
  | (string & {})

export interface SandbankWorkspaceGatewayActor {
  id: string
  kind: 'user' | 'agent' | 'service' | 'external_app' | (string & {})
  scopes?: string[]
  externalAccountId?: string
}

export interface ReadonlySqlPolicy {
  allowExplain?: boolean
  allowWith?: boolean
  allowedSchemas?: string[]
  requiredRelationNames?: string[]
  deniedFunctions?: string[]
}

export interface SandbankWorkspaceGatewayOptions {
  actor: SandbankWorkspaceGatewayActor
  host: SandbankWorkspaceGatewayHost
  runId?: string
  readonlySql?: ReadonlySqlPolicy
}

export interface SandbankReadonlyQueryOptions {
  reason?: string
  policy?: ReadonlySqlPolicy
}

export interface SandbankReadonlyQueryResult extends QueryResult {
  sqlDigest: string
}

export interface SandbankWriteChange {
  path: string
  data: WorkspaceData
}

export interface SandbankWorkspaceChangeProposal {
  id: string
  createdAt: string
  actor: SandbankWorkspaceGatewayActor
  host: SandbankWorkspaceGatewayHost
  runId?: string
  reason?: string
  branchName?: string
  branch?: unknown
  checkpoint?: Checkpoint
  writes: Array<{ path: string }>
  status: 'proposed' | 'applied'
}

export interface SandbankWorkspaceChangeInput {
  reason?: string
  writes: SandbankWriteChange[]
  branchName?: string
}

export interface SandbankWorkspaceGateway {
  describe(): {
    id: string
    kind: string
    capabilities: WorkspaceAdapter['capabilities']
  }
  listResources(path?: string): Promise<WorkspaceEntry[]>
  readResource(path: string): Promise<WorkspaceData>
  queryReadonly(sql: string, options?: SandbankReadonlyQueryOptions): Promise<SandbankReadonlyQueryResult>
  appendMemory(path: string, data: WorkspaceData): Promise<WorkspaceEntry>
  writeArtifact(path: string, data: WorkspaceData): Promise<WorkspaceEntry>
  proposeChange(input: SandbankWorkspaceChangeInput): Promise<SandbankWorkspaceChangeProposal>
  applyApprovedChange(proposal: SandbankWorkspaceChangeProposal, approval: { approved: boolean; approvedBy?: string }): Promise<SandbankWorkspaceChangeProposal>
}

export function createDb9WorkspaceGateway(
  workspace: WorkspaceAdapter,
  options: SandbankWorkspaceGatewayOptions,
): SandbankWorkspaceGateway {
  return {
    describe() {
      return {
        id: workspace.id,
        kind: workspace.kind,
        capabilities: workspace.capabilities,
      }
    },
    listResources(path = '/') {
      return workspace.list(path, { recursive: false })
    },
    readResource(path) {
      return workspace.read(path)
    },
    async queryReadonly(sql, queryOptions = {}) {
      const normalizedSql = normalizeReadonlySql(sql, { ...options.readonlySql, ...queryOptions.policy })
      const result = await workspace.query({ sql: normalizedSql })
      const sqlDigest = simpleDigest(normalizedSql)
      await auditWorkspace(workspace, {
        action: 'sandbank.gateway.query_readonly',
        metadata: {
          actor: options.actor,
          host: options.host,
          runId: options.runId,
          reason: queryOptions.reason,
          sqlDigest,
          rowCount: result.rowCount,
          columns: result.columns,
        },
      })
      return { ...result, sqlDigest }
    },
    appendMemory(path, data) {
      assertScopedPath(path, '/memories/')
      return workspace.append(path, data)
    },
    writeArtifact(path, data) {
      assertScopedPath(path, '/.artifacts/')
      return workspace.write(path, data, { createParents: true })
    },
    async proposeChange(input) {
      if (input.writes.length === 0) {
        throw new WorkspaceError('CONFLICT', 'A workspace change proposal requires at least one write.')
      }
      const id = createId('proposal')
      const branchName = input.branchName ?? `agent/${options.actor.id}/${id}`
      const checkpoint = workspace.capabilities.checkpoint
        ? await workspace.checkpoint(`sandbank:proposal:${id}:before`)
        : undefined
      const branch = workspace.capabilities.branch && isBranchCapable(workspace)
        ? await workspace.createBranch(branchName)
        : undefined
      const proposal: SandbankWorkspaceChangeProposal = {
        id,
        createdAt: new Date().toISOString(),
        actor: options.actor,
        host: options.host,
        runId: options.runId,
        reason: input.reason,
        branchName: branch ? branchName : undefined,
        branch,
        checkpoint,
        writes: input.writes.map(write => ({ path: write.path })),
        status: 'proposed',
      }
      await workspace.write(proposalPath(id), JSON.stringify({
        ...proposal,
        writes: input.writes.map(write => ({ path: write.path, data: dataToJson(write.data) })),
      }, null, 2), { createParents: true })
      await auditWorkspace(workspace, {
        action: 'sandbank.gateway.propose_change',
        path: proposalPath(id),
        metadata: {
          actor: options.actor,
          host: options.host,
          runId: options.runId,
          proposalId: id,
          branchName: proposal.branchName,
          checkpointRef: checkpoint?.ref,
          paths: proposal.writes.map(write => write.path),
        },
      })
      return proposal
    },
    async applyApprovedChange(proposal, approval) {
      if (!approval.approved) {
        throw new WorkspaceError('LOCKED', `Workspace change proposal ${proposal.id} has not been approved.`)
      }
      const stored = await workspace.read(proposalPath(proposal.id))
      const parsed = JSON.parse(dataToText(stored)) as {
        writes?: Array<{ path?: string; data?: unknown }>
      }
      for (const write of parsed.writes ?? []) {
        if (!write.path) continue
        await workspace.write(write.path, dataFromJson(write.data), { createParents: true })
      }
      const applied: SandbankWorkspaceChangeProposal = { ...proposal, status: 'applied' }
      await workspace.write(proposalPath(proposal.id), JSON.stringify({
        ...parsed,
        status: 'applied',
        approvedBy: approval.approvedBy,
        appliedAt: new Date().toISOString(),
      }, null, 2), { createParents: true })
      await auditWorkspace(workspace, {
        action: 'sandbank.gateway.apply_change',
        path: proposalPath(proposal.id),
        metadata: {
          actor: options.actor,
          host: options.host,
          runId: options.runId,
          proposalId: proposal.id,
          approvedBy: approval.approvedBy,
        },
      })
      return applied
    },
  }
}

export function normalizeReadonlySql(sql: string, policy: ReadonlySqlPolicy = {}): string {
  const stripped = stripSqlComments(sql).trim()
  if (!stripped) throw new WorkspaceError('CONFLICT', 'Readonly SQL cannot be empty.')
  const withoutTrailingSemicolons = stripped.replace(/;+$/g, '').trim()
  if (withoutTrailingSemicolons.includes(';')) {
    throw new WorkspaceError('LOCKED', 'Readonly SQL cannot contain multiple statements.')
  }

  const lowered = withoutTrailingSemicolons.toLowerCase()
  const allowWith = policy.allowWith ?? true
  const allowExplain = policy.allowExplain ?? true
  const startsReadonly =
    lowered.startsWith('select ')
    || lowered === 'select'
    || (allowWith && (lowered.startsWith('with ') || lowered.startsWith('with recursive ')))
    || (allowExplain && /^explain\s+(select|with)\b/.test(lowered))
  if (!startsReadonly) {
    throw new WorkspaceError('LOCKED', 'Only SELECT, WITH, or EXPLAIN SELECT statements are allowed.')
  }

  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(withoutTrailingSemicolons)) {
    throw new WorkspaceError('LOCKED', 'Readonly SQL cannot request row locks.')
  }
  const deniedKeyword = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|call|do|copy|vacuum|listen|notify|set|reset|comment)\b/i
  if (deniedKeyword.test(withoutTrailingSemicolons)) {
    throw new WorkspaceError('LOCKED', 'Readonly SQL contains a write or administrative keyword.')
  }

  const deniedFunctions = [
    'pg_sleep',
    'dblink',
    'lo_import',
    'lo_export',
    'http_',
    'net.http',
    ...(policy.deniedFunctions ?? []),
  ]
  const loweredSql = withoutTrailingSemicolons.toLowerCase()
  for (const fn of deniedFunctions) {
    if (loweredSql.includes(fn.toLowerCase())) {
      throw new WorkspaceError('LOCKED', `Readonly SQL cannot call ${fn}.`)
    }
  }

  if ((policy.allowedSchemas?.length ?? 0) > 0) {
    const allowedSchemas = new Set((policy.allowedSchemas ?? []).map(schema => schema.toLowerCase()))
    const schemaRefs = [...withoutTrailingSemicolons.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)\./gi)]
      .map(match => match[1]?.toLowerCase())
      .filter((schema): schema is string => Boolean(schema))
    const deniedSchema = schemaRefs.find(schema => !allowedSchemas.has(schema))
    if (deniedSchema) {
      throw new WorkspaceError('LOCKED', `Readonly SQL references schema ${deniedSchema} outside the allowlist.`)
    }
  }

  for (const relation of policy.requiredRelationNames ?? []) {
    if (!new RegExp(`\\b${escapeRegExp(relation)}\\b`, 'i').test(withoutTrailingSemicolons)) {
      throw new WorkspaceError('LOCKED', `Readonly SQL must reference ${relation}.`)
    }
  }

  return withoutTrailingSemicolons
}

async function auditWorkspace(workspace: WorkspaceAdapter, op: AgentOp): Promise<void> {
  if (workspace.capabilities.log) {
    await workspace.log(op)
    return
  }
  if (workspace.capabilities.append) {
    await workspace.append('/.sandbank/audit.jsonl', `${JSON.stringify({
      ...op,
      createdAt: new Date().toISOString(),
    })}\n`)
  }
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
}

function assertScopedPath(path: string, prefix: string): void {
  if (!path.startsWith(prefix)) {
    throw new WorkspaceError('LOCKED', `Path must be scoped under ${prefix}`)
  }
}

function isBranchCapable(workspace: WorkspaceAdapter): workspace is WorkspaceAdapter & { createBranch(name: string): Promise<unknown> } {
  return typeof (workspace as { createBranch?: unknown }).createBranch === 'function'
}

function proposalPath(id: string): string {
  return `/.sandbank/proposals/${id}.json`
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function simpleDigest(input: string): string {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function dataToText(data: WorkspaceData): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data)
}

function dataToJson(data: WorkspaceData): { encoding: 'text' | 'base64'; value: string } {
  if (typeof data === 'string') return { encoding: 'text', value: data }
  return { encoding: 'base64', value: encodeBase64(data) }
}

function dataFromJson(value: unknown): WorkspaceData {
  if (!value || typeof value !== 'object') return ''
  const record = value as { encoding?: unknown; value?: unknown }
  if (record.encoding === 'base64' && typeof record.value === 'string') return decodeBase64(record.value)
  return typeof record.value === 'string' ? record.value : ''
}

function encodeBase64(data: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(data).toString('base64')
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64')
  const binary = atob(value)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
