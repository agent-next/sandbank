import { Db9WorkspaceAdapter } from '@sandbank.dev/db9'
import type { Db9ScopedToken, Db9ScopedTokenRequest } from '@sandbank.dev/db9'
import type { WorkspaceAdapter } from '@sandbank.dev/workspace'
import {
  createCapabilityRegistry,
  createToolUseRegistryFromSandbankApp,
  mintSandbankScopedToken,
  printCapabilitySDL,
  projectSandbankApp,
  type SandbankCapabilityResult,
} from 'sandbank/app-kernel'
import { createLocalDb9NotesWorkspace } from './local-db9-workspace.js'
import {
  createNotesAiApp,
  seedNotesWorkspace,
  type NotesApplyOutput,
  type NotesListOutput,
  type NotesProposalOutput,
} from './sandbank.app.js'

const mode = process.env['DB9_TOKEN'] && process.env['DB9_DB_ID']
  ? 'real-db9'
  : 'local-db9-compatible'

const workspace = createWorkspace()
await seedNotesWorkspace(workspace)

const app = createNotesAiApp(workspace)
const projection = projectSandbankApp(app)
const registry = createCapabilityRegistry(app)
const actor = {
  id: 'user_1',
  kind: 'user' as const,
  scopes: ['notes:read', 'notes:write'],
}
const context = {
  appId: app.id,
  actor,
  host: 'codex' as const,
  runId: `verify_${Date.now().toString(36)}`,
}
const scopedGrant = mintSandbankScopedToken({
  appId: app.id,
  subject: actor,
  grants: [
    { scope: 'notes:read', object: 'Note', pathPrefix: '/notes', expiresAt: new Date(Date.now() + 300_000).toISOString() },
    { scope: 'notes:write', object: 'Note', pathPrefix: '/notes', expiresAt: new Date(Date.now() + 300_000).toISOString() },
  ],
  ttlMs: 300_000,
})
const db9ScopedToken = await maybeCreateDb9ScopedToken(workspace)

const before = await registry.execute<NotesListOutput>({ name: 'notes.list' }, context)
assert(before.output.notes.some(note => note.id === 'note_1'), 'seed note should be listed')

const inspect = await registry.execute<{ readonlySql: boolean }>({ name: 'notes.inspect' }, context)
assert(inspect.output.readonlySql, 'readonly SQL gateway should work')

const proposal = await registry.execute<NotesProposalOutput>({
  name: 'notes.proposeChange',
  input: {
    note: {
      id: 'note_2',
      title: 'Approved note',
      body: 'This note is applied only after approval.',
      tags: ['approval'],
      updatedAt: '2026-07-09T01:00:00.000Z',
    },
  },
}, context)

const afterProposal = await registry.execute<NotesListOutput>({ name: 'notes.list' }, context)
assert(!afterProposal.output.notes.some(note => note.id === 'note_2'), 'proposal should not apply before approval')

let deniedWithoutApproval = false
try {
  await registry.execute<NotesApplyOutput>({
    name: 'notes.applyProposal',
    input: { proposal: proposal.output.proposal },
  }, context)
} catch {
  deniedWithoutApproval = true
}
assert(deniedWithoutApproval, 'apply should require approval')

const applied = await registry.execute<NotesApplyOutput>({
  name: 'notes.applyProposal',
  input: { proposal: proposal.output.proposal },
  approved: true,
}, context)
assert(applied.output.status === 'applied', 'approved proposal should apply')

const afterApply = await registry.execute<NotesListOutput>({ name: 'notes.list' }, context)
assert(afterApply.output.notes.some(note => note.id === 'note_2'), 'approved note should be visible')

const toolRegistry = createToolUseRegistryFromSandbankApp(app)
const toolResult = await toolRegistry.execute<SandbankCapabilityResult<NotesListOutput>>({
  tool: 'notes.list',
}, {
  agentId: 'agent_1',
  workspaceId: workspace.id,
  runId: context.runId,
  modelId: 'local-verify',
  workspace,
  policy: {
    allowedTools: ['notes.list'],
    resources: [{ kind: 'sandbank.scope', id: 'notes:read', scope: 'notes:read', actions: ['use'] }],
  },
})
assert(toolResult.output.notes.length === afterApply.output.notes.length, 'Tool Use projection should read same notes')

console.log(JSON.stringify({
  ok: true,
  mode,
  appId: app.id,
  workspace: { id: workspace.id, kind: workspace.kind },
  scopedGrant: {
    active: true,
    tokenPrefix: scopedGrant.token.slice(0, 24),
    expiresAt: scopedGrant.expiresAt,
  },
  db9ScopedToken,
  capabilities: projection.capabilities.map(capability => capability.name),
  capabilitySDL: printCapabilitySDL(app).split('\n').slice(0, 8),
  notes: afterApply.output.notes.map(note => ({ id: note.id, title: note.title })),
}, null, 2))

function createWorkspace(): WorkspaceAdapter {
  if (mode === 'real-db9') {
    return new Db9WorkspaceAdapter({
      token: process.env['DB9_TOKEN']!,
      dbId: process.env['DB9_DB_ID']!,
      baseUrl: process.env['DB9_BASE_URL'],
    })
  }
  return createLocalDb9NotesWorkspace()
}

async function maybeCreateDb9ScopedToken(workspace: WorkspaceAdapter): Promise<
  | { created: true; expiresAt?: string; scope?: Record<string, unknown> }
  | { created: false; skippedReason: string }
> {
  if (mode !== 'real-db9') {
    return { created: false, skippedReason: 'local DB9-compatible mode' }
  }
  if (!isDb9ScopedTokenWorkspace(workspace)) {
    return { created: false, skippedReason: 'workspace does not expose createScopedToken' }
  }
  const token = await workspace.createScopedToken({
    name: `notes-ai-app-verify-${Date.now().toString(36)}`,
    expiresInSeconds: 300,
    fs9Scope: '/notes',
    sql: 'read',
  })
  return {
    created: true,
    expiresAt: token.expiresAt,
    scope: token.scope,
  }
}

function isDb9ScopedTokenWorkspace(
  workspace: WorkspaceAdapter,
): workspace is WorkspaceAdapter & { createScopedToken(request: Db9ScopedTokenRequest): Promise<Db9ScopedToken> } {
  return typeof (workspace as { createScopedToken?: unknown }).createScopedToken === 'function'
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
