import { MemoryWorkspaceAdapter } from '@sandbank.dev/workspace'
import { describe, expect, it } from 'vitest'
import {
  createCapabilityRegistry,
  createSandbankAppScaffold,
  createToolUseRegistryFromSandbankApp,
  defineCapability,
  defineObject,
  defineSandbankApp,
  introspectSandbankScopedToken,
  mintSandbankScopedToken,
  printCapabilitySDL,
  projectSandbankApp,
  type SandbankCapabilityResult,
} from './app-kernel.js'
import type { ToolUseExecutionContext } from './tool-use.js'

const app = defineSandbankApp({
  manifestVersion: 1,
  id: 'demo-ai',
  name: 'Demo AI',
  backend: {
    kind: 'db9',
    capabilities: ['readonlySql', 'branchFirstWrites', 'auditLog'],
    readonlySql: true,
    branchFirstWrites: true,
  },
  objects: [
    defineObject({
      name: 'Record',
      storage: { backend: 'db9', table: 'records', branchable: true },
      fields: [
        { name: 'id', type: 'ID', required: true },
        { name: 'title', type: 'String', required: true, filterable: true },
      ],
    }),
  ],
  capabilities: [
    defineCapability({
      name: 'records.list',
      object: 'Record',
      operation: 'query',
      requiredScopes: ['demo:records:read'],
      allowedHostKinds: ['web', 'tool-use'],
      output: [{ name: 'records', type: 'JSON', list: true }],
      handler: async () => ({ records: [{ id: 'rec_1', title: 'First' }] }),
    }),
    defineCapability({
      name: 'records.proposeChange',
      object: 'Record',
      operation: 'mutation',
      requiredScopes: ['demo:records:write'],
      allowedHostKinds: ['web'],
      riskLevel: 'high',
      approval: { mode: 'on_high_risk' },
      handler: async input => ({ proposalId: 'proposal_1', input }),
    }),
  ],
})

describe('Sandbank App Kernel', () => {
  it('authorizes and executes capabilities through one registry', async () => {
    const registry = createCapabilityRegistry(app)
    const result = await registry.execute<{ records: Array<{ id: string }> }>({
      name: 'records.list',
    }, {
      appId: app.id,
      actor: { id: 'user_1', kind: 'user', scopes: ['demo:records:read'] },
      host: 'web',
      runId: 'run_1',
    })

    expect(result.output.records[0]?.id).toBe('rec_1')
    expect(result.audit.capability).toBe('records.list')
  })

  it('requires explicit approval for high-risk write capabilities', async () => {
    const registry = createCapabilityRegistry(app)
    const context = {
      appId: app.id,
      actor: { id: 'user_1', kind: 'user' as const, scopes: ['demo:records:write'] },
      host: 'web' as const,
    }

    await expect(registry.execute({ name: 'records.proposeChange' }, context))
      .rejects.toMatchObject({ code: 'LOCKED' })

    const approved = await registry.execute<{ proposalId: string }>({
      name: 'records.proposeChange',
      approved: true,
    }, context)
    expect(approved.output.proposalId).toBe('proposal_1')
  })

  it('projects the same contract into SDL, host metadata, and Tool Use', async () => {
    const projection = projectSandbankApp(app)
    expect(projection.capabilitySDL).toContain('capability records.list')
    expect(printCapabilitySDL(app)).toContain('@scope(demo:records:read)')
    expect(projection.capabilities[0]?.hosts).toContain('tool-use')

    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace_1' })
    const toolRegistry = createToolUseRegistryFromSandbankApp(app)
    const context: ToolUseExecutionContext = {
      agentId: 'agent_1',
      workspaceId: 'workspace_1',
      runId: 'run_1',
      modelId: 'model_1',
      workspace,
      policy: {
        allowedTools: ['records.list'],
        resources: [{ kind: 'sandbank.scope', id: 'demo:records:read', scope: 'demo:records:read', actions: ['use'] }],
      },
    }
    const result = await toolRegistry.execute<SandbankCapabilityResult<{ records: Array<{ title: string }> }>>({
      tool: 'records.list',
    }, context)
    expect(result.output.records[0]?.title).toBe('First')
  })

  it('mints inspectable scoped grants and app scaffolds', () => {
    const token = mintSandbankScopedToken({
      appId: app.id,
      subject: { id: 'agent_1', kind: 'agent', scopes: ['demo:records:read'] },
      grants: [{ scope: 'demo:records:read', object: 'Record' }],
      ttlMs: 1000,
      now: new Date('2026-07-09T00:00:00.000Z'),
    })
    expect(introspectSandbankScopedToken(token, new Date('2026-07-09T00:00:00.500Z')).active).toBe(true)
    expect(introspectSandbankScopedToken(token, new Date('2026-07-09T00:00:02.000Z')).active).toBe(false)

    const scaffold = createSandbankAppScaffold({ id: 'new-ai-app', backend: 'postgres' })
    expect(scaffold.files['src/sandbank.app.ts']).toContain("kind: 'postgres'")
  })
})
