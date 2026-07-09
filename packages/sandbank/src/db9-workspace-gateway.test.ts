import {
  MemoryWorkspaceAdapter,
  type AgentOp,
  type Checkpoint,
  type ListOptions,
  type MoveOptions,
  type QueryResult,
  type ReadOptions,
  type RemoveOptions,
  type TransactionOptions,
  type WatchOptions,
  type WorkspaceAdapter,
  type WorkspaceData,
  type WorkspaceDiff,
  type WorkspaceEntry,
  type WorkspaceEvent,
  type WorkspaceLock,
  type WorkspaceQuery,
  type WorkspaceRef,
  type WorkspaceTx,
  type WriteOptions,
} from '@sandbank.dev/workspace'
import { describe, expect, it } from 'vitest'
import { createDb9WorkspaceGateway, normalizeReadonlySql } from './db9-workspace-gateway.js'

describe('DB9 workspace gateway', () => {
  it('normalizes readonly SQL and rejects write SQL', () => {
    expect(normalizeReadonlySql('-- inspect\nSELECT id FROM records;')).toBe('SELECT id FROM records')
    expect(() => normalizeReadonlySql('UPDATE records SET title = $1')).toThrow('Only SELECT')
    expect(() => normalizeReadonlySql('SELECT * FROM records; DELETE FROM records')).toThrow('multiple statements')
    expect(() => normalizeReadonlySql('SELECT * FROM records FOR UPDATE')).toThrow('row locks')
    expect(() => normalizeReadonlySql('EXPLAIN ANALYZE SELECT * FROM records')).toThrow('Only SELECT')
    expect(() => normalizeReadonlySql('SELECT * FROM public.records JOIN private.audit ON true', { allowedSchemas: ['public'] }))
      .toThrow('private')
  })

  it('runs readonly queries through the workspace query surface and audits them', async () => {
    let seenSql = ''
    const workspace = createSqlWorkspace(async expr => {
      seenSql = expr.sql ?? ''
      return { columns: ['id'], rows: [{ id: 'rec_1' }], rowCount: 1 }
    })
    const gateway = createDb9WorkspaceGateway(workspace, {
      actor: { id: 'agent_1', kind: 'agent', scopes: ['demo:records:read'] },
      host: 'codex',
      runId: 'run_1',
    })

    const result = await gateway.queryReadonly('SELECT id FROM records', { reason: 'inspect records' })
    expect(result.rowCount).toBe(1)
    expect(result.sqlDigest).toBeTruthy()
    expect(seenSql).toBe('SELECT id FROM records')

    const log = await workspace.query({ kind: 'log' })
    expect(JSON.stringify(log.rows)).toContain('sandbank.gateway.query_readonly')
    expect(JSON.stringify(log.rows)).toContain('inspect records')
  })

  it('keeps writes behind proposals and approval', async () => {
    const workspace = createSqlWorkspace(async () => ({ rows: [], rowCount: 0 }))
    const gateway = createDb9WorkspaceGateway(workspace, {
      actor: { id: 'agent_1', kind: 'agent', scopes: ['demo:records:write'] },
      host: 'cloud_code',
    })

    const proposal = await gateway.proposeChange({
      reason: 'change record title',
      writes: [{ path: '/records/rec_1.json', data: JSON.stringify({ title: 'First' }) }],
    })

    await expect(workspace.read('/records/rec_1.json')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(gateway.applyApprovedChange(proposal, { approved: false })).rejects.toMatchObject({ code: 'LOCKED' })

    await gateway.applyApprovedChange(proposal, { approved: true, approvedBy: 'user_1' })
    expect(String(await workspace.read('/records/rec_1.json'))).toContain('First')
    expect(proposal.branchName).toContain('agent/agent_1/')
  })
})

function createSqlWorkspace(
  queryHandler: (expr: WorkspaceQuery) => Promise<QueryResult>,
): WorkspaceAdapter & { createBranch(name: string): Promise<{ name: string }> } {
  const base = new MemoryWorkspaceAdapter(undefined, { id: 'workspace_1' })
  return {
    id: base.id,
    kind: 'db9-test',
    capabilities: {
      ...base.capabilities,
      sqlQuery: true,
      branch: true,
    },
    list(path: string, opts?: ListOptions): Promise<WorkspaceEntry[]> {
      return base.list(path, opts)
    },
    read(path: string, opts?: ReadOptions): Promise<WorkspaceData> {
      return base.read(path, opts)
    },
    write(path: string, data: WorkspaceData, opts?: WriteOptions): Promise<WorkspaceEntry> {
      return base.write(path, data, opts)
    },
    append(path: string, data: WorkspaceData): Promise<WorkspaceEntry> {
      return base.append(path, data)
    },
    remove(path: string, opts?: RemoveOptions): Promise<void> {
      return base.remove(path, opts)
    },
    move(from: string, to: string, opts?: MoveOptions): Promise<void> {
      return base.move(from, to, opts)
    },
    stat(path: string): Promise<WorkspaceEntry> {
      return base.stat(path)
    },
    query(expr: WorkspaceQuery): Promise<QueryResult> {
      if (!expr.sql) return base.query(expr)
      return queryHandler(expr)
    },
    transaction<T>(fn: (tx: WorkspaceTx) => Promise<T>, opts?: TransactionOptions): Promise<T> {
      return base.transaction(fn, opts)
    },
    checkpoint(label?: string): Promise<Checkpoint> {
      return base.checkpoint(label)
    },
    diff(a: WorkspaceRef, b: WorkspaceRef): Promise<WorkspaceDiff> {
      return base.diff(a, b)
    },
    rollback(ref: WorkspaceRef): Promise<void> {
      return base.rollback(ref)
    },
    watch(path: string, opts?: WatchOptions): AsyncIterable<WorkspaceEvent> {
      return base.watch(path, opts)
    },
    lock(resource: string, ttlMs: number): Promise<WorkspaceLock> {
      return base.lock(resource, ttlMs)
    },
    log(op: AgentOp): Promise<string> {
      return base.log(op)
    },
    async createBranch(name: string): Promise<{ name: string }> {
      return { name }
    },
  }
}
