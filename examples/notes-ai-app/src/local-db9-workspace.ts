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

export function createLocalDb9NotesWorkspace(): WorkspaceAdapter & {
  createBranch(name: string): Promise<{ id: string; name: string; state: string }>
} {
  const base = new MemoryWorkspaceAdapter(undefined, { id: 'local-db9-notes' })
  return {
    id: base.id,
    kind: 'local-db9-compatible',
    capabilities: {
      ...base.capabilities,
      sqlQuery: true,
      branch: true,
      fileAsTable: true,
      provider: {
        ...base.capabilities.provider,
        db9Compatible: true,
        scopedToken: 'sandbank-local',
      },
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
    async query(expr: WorkspaceQuery): Promise<QueryResult> {
      if (!expr.sql) return base.query(expr)
      const sql = expr.sql.trim().toLowerCase()
      if (/^select\s+1\s+as\s+ok$/.test(sql)) {
        return { columns: ['ok'], rows: [{ ok: 1 }], rowCount: 1 }
      }
      if (/\bfrom\s+notes\b/.test(sql)) {
        const entries = await base.list('/notes').catch(() => [])
        const rows = []
        for (const entry of entries) {
          if (entry.type !== 'file' || !entry.path.endsWith('.json')) continue
          rows.push(JSON.parse(String(await base.read(entry.path))) as unknown)
        }
        return { columns: ['id', 'title', 'body', 'tags', 'updatedAt'], rows, rowCount: rows.length }
      }
      return { columns: [], rows: [], rowCount: 0 }
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
    async createBranch(name: string): Promise<{ id: string; name: string; state: string }> {
      return { id: `local-branch:${name}`, name, state: 'ready' }
    },
  }
}
