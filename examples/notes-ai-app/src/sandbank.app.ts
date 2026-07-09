import { WorkspaceError, type WorkspaceAdapter } from '@sandbank.dev/workspace'
import {
  defineCapability,
  defineObject,
  defineSandbankApp,
  type SandbankCapabilityContext,
} from 'sandbank/app-kernel'
import {
  createDb9WorkspaceGateway,
  type SandbankWorkspaceChangeProposal,
} from 'sandbank/workspace-gateway'

export interface Note {
  id: string
  title: string
  body: string
  tags?: string[]
  updatedAt: string
}

export interface NotesListOutput {
  notes: Note[]
}

export interface NotesProposalOutput {
  proposalId: string
  proposal: SandbankWorkspaceChangeProposal
}

export interface NotesApplyOutput {
  proposalId: string
  status: 'applied'
}

export function createNotesAiApp(workspace: WorkspaceAdapter) {
  return defineSandbankApp({
    manifestVersion: 1,
    id: 'notes-ai-app',
    name: 'Notes AI App',
    version: '0.1.0',
    backend: {
      kind: 'db9',
      capabilities: ['files', 'readonlySql', 'branchFirstWrites', 'auditLog', 'scopedToken'],
      readonlySql: true,
      branchFirstWrites: true,
    },
    objects: [
      defineObject({
        name: 'Note',
        storage: { backend: 'db9', pathPrefix: '/notes', branchable: true },
        scopes: {
          read: 'notes:read',
          write: 'notes:write',
        },
        fields: [
          { name: 'id', type: 'ID', required: true },
          { name: 'title', type: 'String', required: true, filterable: true },
          { name: 'body', type: 'String', required: true },
          { name: 'tags', type: 'String', list: true, filterable: true },
          { name: 'updatedAt', type: 'DateTime', required: true, sortable: true },
        ],
      }),
    ],
    capabilities: [
      defineCapability({
        name: 'notes.list',
        title: 'List notes',
        object: 'Note',
        operation: 'query',
        requiredScopes: ['notes:read'],
        allowedHostKinds: ['web', 'codex', 'cloud_code', 'mcp', 'cli', 'tool-use'],
        output: [{ name: 'notes', type: 'JSON', list: true }],
        handler: async (_input, context) => listNotes(workspace, context),
      }),
      defineCapability({
        name: 'notes.inspect',
        title: 'Inspect backend',
        object: 'Note',
        operation: 'query',
        requiredScopes: ['notes:read'],
        allowedHostKinds: ['web', 'codex', 'cloud_code', 'mcp', 'cli', 'tool-use'],
        output: [
          { name: 'workspaceKind', type: 'String', required: true },
          { name: 'readonlySql', type: 'Boolean', required: true },
        ],
        handler: async (_input, context) => inspectBackend(workspace, context),
      }),
      defineCapability({
        name: 'notes.proposeChange',
        title: 'Propose note change',
        object: 'Note',
        operation: 'mutation',
        requiredScopes: ['notes:write'],
        allowedHostKinds: ['web', 'codex', 'cloud_code', 'mcp', 'cli', 'tool-use'],
        riskLevel: 'medium',
        input: [{ name: 'note', type: 'JSON', required: true }],
        output: [
          { name: 'proposalId', type: 'ID', required: true },
          { name: 'proposal', type: 'JSON', required: true },
        ],
        handler: async (input, context) => proposeNoteChange(workspace, input, context),
      }),
      defineCapability({
        name: 'notes.applyProposal',
        title: 'Apply approved note proposal',
        object: 'Note',
        operation: 'action',
        requiredScopes: ['notes:write'],
        allowedHostKinds: ['web', 'codex', 'cloud_code', 'mcp', 'cli', 'tool-use'],
        riskLevel: 'high',
        approval: { mode: 'always', reason: 'Applying a proposal changes user-visible note data.' },
        input: [{ name: 'proposal', type: 'JSON', required: true }],
        output: [
          { name: 'proposalId', type: 'ID', required: true },
          { name: 'status', type: 'String', required: true },
        ],
        handler: async (input, context) => applyNoteProposal(workspace, input, context),
      }),
    ],
    views: [
      {
        name: 'notes.list',
        object: 'Note',
        fields: ['id', 'title', 'body', 'tags', 'updatedAt'],
        actions: ['notes.list', 'notes.proposeChange', 'notes.applyProposal'],
      },
    ],
  })
}

export async function seedNotesWorkspace(workspace: WorkspaceAdapter): Promise<void> {
  const existing = await workspace.list('/notes').catch(() => [])
  if (existing.length > 0) return
  await workspace.write(notePath('note_1'), JSON.stringify({
    id: 'note_1',
    title: 'First Sandbank note',
    body: 'This note is stored through the WorkspaceAdapter, not a hand-written REST API.',
    tags: ['sandbank', 'db9'],
    updatedAt: '2026-07-09T00:00:00.000Z',
  }, null, 2), { createParents: true })
}

async function listNotes(
  workspace: WorkspaceAdapter,
  context: SandbankCapabilityContext,
): Promise<NotesListOutput> {
  const gateway = gatewayFor(workspace, context)
  const entries = await gateway.listResources('/notes').catch(() => [])
  const notes: Note[] = []
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.path.endsWith('.json')) continue
    const raw = await gateway.readResource(entry.path)
    notes.push(parseNote(JSON.parse(dataToText(raw)) as Record<string, unknown>))
  }
  notes.sort((a, b) => a.id.localeCompare(b.id))
  return { notes }
}

async function inspectBackend(
  workspace: WorkspaceAdapter,
  context: SandbankCapabilityContext,
): Promise<{ workspaceKind: string; readonlySql: boolean; rows: unknown[] }> {
  const gateway = gatewayFor(workspace, context)
  const result = await gateway.queryReadonly('SELECT 1 AS ok', { reason: 'notes-ai-app backend inspection' })
  return {
    workspaceKind: workspace.kind,
    readonlySql: result.rowCount === 1,
    rows: result.rows,
  }
}

async function proposeNoteChange(
  workspace: WorkspaceAdapter,
  input: unknown,
  context: SandbankCapabilityContext,
): Promise<NotesProposalOutput> {
  const note = parseNote((input as { note?: unknown } | undefined)?.note)
  const gateway = gatewayFor(workspace, context)
  const proposal = await gateway.proposeChange({
    reason: `Upsert ${note.id}`,
    writes: [{ path: notePath(note.id), data: JSON.stringify(note, null, 2) }],
  })
  return { proposalId: proposal.id, proposal }
}

async function applyNoteProposal(
  workspace: WorkspaceAdapter,
  input: unknown,
  context: SandbankCapabilityContext,
): Promise<NotesApplyOutput> {
  const proposal = (input as { proposal?: SandbankWorkspaceChangeProposal } | undefined)?.proposal
  if (!proposal) throw new WorkspaceError('CONFLICT', 'notes.applyProposal requires a proposal.')
  const gateway = gatewayFor(workspace, context)
  const applied = await gateway.applyApprovedChange(proposal, {
    approved: Boolean(context.approved),
    approvedBy: context.actor.id,
  })
  return { proposalId: applied.id, status: 'applied' }
}

function gatewayFor(workspace: WorkspaceAdapter, context: SandbankCapabilityContext) {
  return createDb9WorkspaceGateway(workspace, {
    actor: context.actor,
    host: context.host,
    runId: context.runId,
  })
}

function notePath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new WorkspaceError('INVALID_PATH', `Invalid note id: ${id}`)
  }
  return `/notes/${id}.json`
}

function parseNote(value: unknown): Note {
  if (!value || typeof value !== 'object') {
    throw new WorkspaceError('CONFLICT', 'Note must be an object.')
  }
  const record = value as Record<string, unknown>
  const id = stringField(record, 'id')
  return {
    id,
    title: stringField(record, 'title'),
    body: stringField(record, 'body'),
    tags: Array.isArray(record['tags']) ? record['tags'].map(String) : [],
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : new Date().toISOString(),
  }
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkspaceError('CONFLICT', `Note ${field} must be a non-empty string.`)
  }
  return value
}

function dataToText(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data)
}
