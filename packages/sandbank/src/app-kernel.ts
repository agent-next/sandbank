import { WorkspaceError } from '@sandbank.dev/workspace'
import {
  ToolUseRegistry,
  type ToolUseDefinition,
  type ToolUseExecutionContext,
  type ToolUseResourceRequirement,
} from './tool-use.js'

export const SANDBANK_APP_MANIFEST_VERSION = 1 as const

export type SandbankHostKind =
  | 'web'
  | 'codex'
  | 'cloud_code'
  | 'mcp'
  | 'cli'
  | 'worker'
  | 'tool-use'
  | (string & {})

export type SandbankActorKind =
  | 'user'
  | 'agent'
  | 'service'
  | 'external_app'
  | (string & {})

export type SandbankCapabilityOperation =
  | 'query'
  | 'mutation'
  | 'action'
  | 'subscription'

export type SandbankRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type SandbankApprovalMode = 'never' | 'always' | 'on_write' | 'on_high_risk'
export type SandbankScalarType =
  | 'ID'
  | 'String'
  | 'Int'
  | 'Float'
  | 'Boolean'
  | 'JSON'
  | 'DateTime'
  | 'Vector'
  | 'File'
  | (string & {})

export interface SandbankFieldDefinition {
  name: string
  type: SandbankScalarType
  required?: boolean
  list?: boolean
  description?: string
  selectable?: boolean
  filterable?: boolean
  sortable?: boolean
}

export interface SandbankObjectStorage {
  backend?: 'db9' | 'postgres' | 'workspace' | (string & {})
  table?: string
  pathPrefix?: string
  branchable?: boolean
}

export interface SandbankObjectDefinition {
  name: string
  description?: string
  storage?: SandbankObjectStorage
  fields?: SandbankFieldDefinition[]
  scopes?: {
    read?: string
    write?: string
    admin?: string
  }
}

export interface SandbankApprovalPolicy {
  mode: SandbankApprovalMode
  reason?: string
  reviewers?: SandbankActorKind[]
}

export interface SandbankAuditShape {
  category?: string
  includeInput?: boolean
  includeOutput?: boolean
  redactFields?: string[]
}

export interface SandbankProjectionSet {
  web?: boolean
  codex?: boolean
  cloudCode?: boolean
  mcp?: boolean
  cli?: boolean
  toolUse?: boolean
  viewModel?: string
}

export interface SandbankCapabilityDefinition<Input = unknown, Output = unknown> {
  name: string
  title?: string
  description?: string
  object?: string
  operation: SandbankCapabilityOperation
  input?: SandbankFieldDefinition[]
  output?: SandbankFieldDefinition[]
  requiredScopes?: string[]
  allowedActorKinds?: SandbankActorKind[]
  allowedHostKinds?: SandbankHostKind[]
  riskLevel?: SandbankRiskLevel
  approval?: SandbankApprovalPolicy
  audit?: SandbankAuditShape
  projection?: SandbankProjectionSet
  handler?: SandbankCapabilityHandler<Input, Output>
}

export interface SandbankViewModelDefinition {
  name: string
  object?: string
  description?: string
  fields?: string[]
  actions?: string[]
}

export interface SandbankBackendRequirement {
  kind: 'db9' | 'postgres' | 'workspace' | (string & {})
  capabilities?: string[]
  readonlySql?: boolean
  branchFirstWrites?: boolean
}

export interface SandbankAppManifest {
  manifestVersion: typeof SANDBANK_APP_MANIFEST_VERSION
  id: string
  name: string
  version?: string
  description?: string
  backend?: SandbankBackendRequirement
  objects?: SandbankObjectDefinition[]
  capabilities: SandbankCapabilityDefinition[]
  views?: SandbankViewModelDefinition[]
}

export interface SandbankAuthorizationSubject {
  id: string
  kind: SandbankActorKind
  scopes?: string[]
  externalAccountId?: string
  metadata?: Record<string, unknown>
}

export interface SandbankCapabilityContext {
  appId: string
  actor: SandbankAuthorizationSubject
  host: SandbankHostKind
  runId?: string
  agentId?: string
  workspaceId?: string
  approved?: boolean
  metadata?: Record<string, unknown>
  audit?: (event: SandbankCapabilityAuditEvent) => void | Promise<void>
}

export interface SandbankCapabilityInvocation<Input = unknown> {
  name: string
  input?: Input
  reason?: string
  approved?: boolean
  actor?: SandbankAuthorizationSubject
  host?: SandbankHostKind
  metadata?: Record<string, unknown>
}

export type SandbankCapabilityHandler<Input = unknown, Output = unknown> = (
  input: Input,
  context: SandbankCapabilityContext,
) => Promise<Output> | Output

export interface SandbankCapabilityAuthorization {
  ok: boolean
  capability: string
  requiredScopes: string[]
  requiresApproval: boolean
  approvalReason?: string
  error?: string
  errorCode?: WorkspaceError['code']
}

export interface SandbankCapabilityAuditEvent {
  type: 'sandbank.capability'
  appId: string
  capability: string
  operation: SandbankCapabilityOperation
  actor: SandbankAuthorizationSubject
  host: SandbankHostKind
  runId?: string
  approved: boolean
  reason?: string
  riskLevel: SandbankRiskLevel
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface SandbankCapabilityResult<Output = unknown> {
  output: Output
  authorization: SandbankCapabilityAuthorization
  audit: SandbankCapabilityAuditEvent
}

export interface SandbankScopedGrant {
  scope: string
  object?: string
  pathPrefix?: string
  expiresAt?: string
}

export interface SandbankScopedToken {
  token: string
  appId: string
  subject: SandbankAuthorizationSubject
  grants: SandbankScopedGrant[]
  issuedAt: string
  expiresAt?: string
}

export interface SandbankCapabilityProjection {
  name: string
  title: string
  operation: SandbankCapabilityOperation
  object?: string
  requiredScopes: string[]
  riskLevel: SandbankRiskLevel
  requiresApproval: boolean
  hosts: SandbankHostKind[]
  actors: SandbankActorKind[]
  toolUse: {
    name: string
    resources: ToolUseResourceRequirement[]
  }
  input?: SandbankFieldDefinition[]
  output?: SandbankFieldDefinition[]
}

export interface SandbankAppProjection {
  appId: string
  name: string
  backend?: SandbankBackendRequirement
  capabilities: SandbankCapabilityProjection[]
  views: SandbankViewModelDefinition[]
  capabilitySDL: string
}

export interface SandbankAppScaffoldOptions {
  id: string
  name?: string
  backend?: 'db9' | 'postgres' | 'workspace' | (string & {})
  packageName?: string
}

export interface SandbankAppScaffold {
  id: string
  name: string
  files: Record<string, string>
}

export function defineSandbankApp<const T extends SandbankAppManifest>(manifest: T): T {
  const errors = validateSandbankApp(manifest)
  if (errors.length > 0) {
    throw new WorkspaceError('CONFLICT', `Invalid Sandbank app manifest: ${errors.join('; ')}`)
  }
  return manifest
}

export function defineObject<const T extends SandbankObjectDefinition>(object: T): T {
  if (!object.name.trim()) throw new WorkspaceError('CONFLICT', 'Sandbank object name is required.')
  return object
}

export function defineCapability<const T extends SandbankCapabilityDefinition>(capability: T): T {
  if (!capability.name.trim()) throw new WorkspaceError('CONFLICT', 'Sandbank capability name is required.')
  return capability
}

export function defineApprovalPolicy(
  mode: SandbankApprovalMode,
  options: Omit<SandbankApprovalPolicy, 'mode'> = {},
): SandbankApprovalPolicy {
  return { mode, ...options }
}

export function defineAuditShape(shape: SandbankAuditShape): SandbankAuditShape {
  return shape
}

export function defineViewModel<const T extends SandbankViewModelDefinition>(view: T): T {
  if (!view.name.trim()) throw new WorkspaceError('CONFLICT', 'Sandbank view model name is required.')
  return view
}

export function validateSandbankApp(manifest: SandbankAppManifest): string[] {
  const errors: string[] = []
  if (manifest.manifestVersion !== SANDBANK_APP_MANIFEST_VERSION) {
    errors.push(`manifestVersion must be ${SANDBANK_APP_MANIFEST_VERSION}`)
  }
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(manifest.id)) {
    errors.push('id must be lower-kebab-case and 2-63 characters')
  }
  if (!manifest.name.trim()) errors.push('name is required')
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    errors.push('at least one capability is required')
  }

  const objectNames = new Set((manifest.objects ?? []).map(object => object.name))
  const capabilityNames = new Set<string>()
  for (const capability of manifest.capabilities ?? []) {
    if (!capability.name.trim()) errors.push('capability name is required')
    if (capabilityNames.has(capability.name)) errors.push(`duplicate capability: ${capability.name}`)
    capabilityNames.add(capability.name)
    if (capability.object && !objectNames.has(capability.object)) {
      errors.push(`capability ${capability.name} references unknown object ${capability.object}`)
    }
    if (capability.operation === 'mutation' && capability.approval?.mode === 'never' && capability.riskLevel === 'critical') {
      errors.push(`critical mutation ${capability.name} cannot disable approval`)
    }
  }

  return errors
}

export class SandbankCapabilityRegistry {
  private readonly definitions = new Map<string, SandbankCapabilityDefinition>()

  constructor(readonly app: SandbankAppManifest) {
    defineSandbankApp(app)
    for (const capability of app.capabilities) this.register(capability)
  }

  register(definition: SandbankCapabilityDefinition): this {
    if (this.definitions.has(definition.name)) {
      throw new WorkspaceError('CONFLICT', `Capability is already registered: ${definition.name}`)
    }
    this.definitions.set(definition.name, definition)
    return this
  }

  get(name: string): SandbankCapabilityDefinition | undefined {
    return this.definitions.get(name)
  }

  list(): SandbankCapabilityDefinition[] {
    return [...this.definitions.values()]
  }

  authorize(
    invocation: SandbankCapabilityInvocation,
    context: SandbankCapabilityContext,
  ): SandbankCapabilityAuthorization {
    const definition = this.definitions.get(invocation.name)
    if (!definition) {
      return {
        ok: false,
        capability: invocation.name,
        requiredScopes: [],
        requiresApproval: false,
        error: `Capability is not registered: ${invocation.name}`,
        errorCode: 'UNSUPPORTED',
      }
    }

    const actor = invocation.actor ?? context.actor
    const host = invocation.host ?? context.host
    if (definition.allowedActorKinds?.length && !definition.allowedActorKinds.includes(actor.kind)) {
      return denied(definition, `Capability ${definition.name} is not available to actor kind ${actor.kind}`)
    }
    if (definition.allowedHostKinds?.length && !definition.allowedHostKinds.includes(host)) {
      return denied(definition, `Capability ${definition.name} is not available on host ${host}`)
    }

    const requiredScopes = definition.requiredScopes ?? []
    const scopes = new Set(actor.scopes ?? [])
    const missingScopes = requiredScopes.filter(scope => !scopes.has(scope))
    if (missingScopes.length > 0) {
      return denied(definition, `Capability ${definition.name} is missing scopes: ${missingScopes.join(', ')}`, requiredScopes)
    }

    const requiresApproval = capabilityRequiresApproval(definition)
    return {
      ok: true,
      capability: definition.name,
      requiredScopes,
      requiresApproval,
      approvalReason: requiresApproval
        ? definition.approval?.reason ?? `Capability ${definition.name} requires approval.`
        : undefined,
    }
  }

  async execute<Output = unknown>(
    invocation: SandbankCapabilityInvocation,
    context: SandbankCapabilityContext,
  ): Promise<SandbankCapabilityResult<Output>> {
    const definition = this.definitions.get(invocation.name)
    const authorization = this.authorize(invocation, context)
    if (!authorization.ok) {
      throw new WorkspaceError(authorization.errorCode ?? 'LOCKED', authorization.error ?? `Capability denied: ${invocation.name}`)
    }
    if (authorization.requiresApproval && !(invocation.approved ?? context.approved)) {
      throw new WorkspaceError('LOCKED', authorization.approvalReason ?? `Capability requires approval: ${invocation.name}`)
    }
    if (!definition?.handler) {
      throw new WorkspaceError('UNSUPPORTED', `Capability does not have a handler: ${invocation.name}`)
    }

    const runContext: SandbankCapabilityContext = {
      ...context,
      actor: invocation.actor ?? context.actor,
      host: invocation.host ?? context.host,
      approved: invocation.approved ?? context.approved,
      metadata: { ...context.metadata, ...invocation.metadata },
    }
    const output = await definition.handler(invocation.input, runContext) as Output
    const audit = createCapabilityAuditEvent(this.app.id, definition, invocation, runContext)
    await runContext.audit?.(audit)
    return { output, authorization, audit }
  }
}

export function createCapabilityRegistry(app: SandbankAppManifest): SandbankCapabilityRegistry {
  return new SandbankCapabilityRegistry(app)
}

export function projectSandbankApp(app: SandbankAppManifest): SandbankAppProjection {
  defineSandbankApp(app)
  return {
    appId: app.id,
    name: app.name,
    backend: app.backend,
    capabilities: app.capabilities.map(projectCapability),
    views: app.views ?? [],
    capabilitySDL: printCapabilitySDL(app),
  }
}

export function printCapabilitySDL(app: SandbankAppManifest): string {
  defineSandbankApp(app)
  const lines: string[] = [
    `app ${app.id} @version(${JSON.stringify(app.version ?? '0.0.0')}) {`,
  ]
  if (app.backend) {
    const capabilities = app.backend.capabilities?.length ? ` capabilities: [${app.backend.capabilities.join(', ')}]` : ''
    lines.push(`  backend ${app.backend.kind}${capabilities}`)
  }
  for (const object of app.objects ?? []) {
    lines.push(`  object ${object.name} {`)
    for (const field of object.fields ?? []) lines.push(`    ${field.name}: ${fieldType(field)}`)
    lines.push('  }')
  }
  for (const capability of app.capabilities) {
    const input = formatFields(capability.input)
    const output = formatFields(capability.output)
    const scopes = capability.requiredScopes?.length ? ` @scope(${capability.requiredScopes.join(',')})` : ''
    const hosts = capability.allowedHostKinds?.length ? ` @hosts(${capability.allowedHostKinds.join(',')})` : ''
    const approval = capabilityRequiresApproval(capability) ? ' @approval' : ''
    lines.push(`  capability ${capability.name}(${input}): ${output || 'JSON'} @${capability.operation}${scopes}${hosts}${approval}`)
  }
  lines.push('}')
  return lines.join('\n')
}

export function projectCapabilityToToolUseResources(
  capability: SandbankCapabilityDefinition,
): ToolUseResourceRequirement[] {
  return (capability.requiredScopes ?? []).map(scope => ({
    kind: 'sandbank.scope',
    id: scope,
    scope,
    action: 'use',
  }))
}

export interface SandbankToolUseProjectionOptions {
  toolNamePrefix?: string
  context?: (
    toolContext: ToolUseExecutionContext,
    capability: SandbankCapabilityDefinition,
  ) => SandbankCapabilityContext | Promise<SandbankCapabilityContext>
}

export function createToolUseRegistryFromSandbankApp(
  app: SandbankAppManifest,
  options: SandbankToolUseProjectionOptions = {},
): ToolUseRegistry {
  const capabilityRegistry = createCapabilityRegistry(app)
  const toolRegistry = new ToolUseRegistry()
  for (const capability of app.capabilities) {
    toolRegistry.register(createCapabilityToolUseDefinition(capabilityRegistry, capability, options))
  }
  return toolRegistry
}

export function createCapabilityToolUseDefinition(
  registry: SandbankCapabilityRegistry,
  capability: SandbankCapabilityDefinition,
  options: SandbankToolUseProjectionOptions = {},
): ToolUseDefinition<unknown, unknown> {
  const toolName = options.toolNamePrefix ? `${options.toolNamePrefix}.${capability.name}` : capability.name
  return {
    name: toolName,
    description: capability.description ?? capability.title,
    resourceRequirements: () => projectCapabilityToToolUseResources(capability),
    async handler(input, toolContext) {
      const context = options.context
        ? await options.context(toolContext, capability)
        : defaultToolUseCapabilityContext(registry.app.id, toolContext)
      return registry.execute({ name: capability.name, input, approved: toolContext.approved }, context)
    },
  }
}

export function mintSandbankScopedToken(options: {
  appId: string
  subject: SandbankAuthorizationSubject
  grants: SandbankScopedGrant[]
  ttlMs?: number
  now?: Date
}): SandbankScopedToken {
  const now = options.now ?? new Date()
  const expiresAt = options.ttlMs ? new Date(now.getTime() + options.ttlMs).toISOString() : undefined
  const scopeDigest = simpleDigest(JSON.stringify(options.grants))
  return {
    token: `sandbank_scoped_${options.appId}_${now.getTime().toString(36)}_${scopeDigest}_${randomSuffix()}`,
    appId: options.appId,
    subject: options.subject,
    grants: options.grants,
    issuedAt: now.toISOString(),
    expiresAt,
  }
}

export function introspectSandbankScopedToken(token: SandbankScopedToken, now: Date = new Date()): {
  active: boolean
  appId: string
  subject: SandbankAuthorizationSubject
  grants: SandbankScopedGrant[]
  expiresAt?: string
} {
  const active = !token.expiresAt || new Date(token.expiresAt).getTime() > now.getTime()
  return {
    active,
    appId: token.appId,
    subject: token.subject,
    grants: token.grants,
    expiresAt: token.expiresAt,
  }
}

export function createSandbankAppScaffold(options: SandbankAppScaffoldOptions): SandbankAppScaffold {
  const id = normalizeAppId(options.id)
  const name = options.name ?? titleFromId(id)
  const backend = options.backend ?? 'db9'
  const packageName = options.packageName ?? id
  const scopePrefix = id.replaceAll('-', ':')
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({
      name: packageName,
      private: true,
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        sandbank: 'workspace:*',
      },
      devDependencies: {
        typescript: '^5.7.3',
      },
    }, null, 2)}\n`,
    'src/sandbank.app.ts': `import { defineCapability, defineObject, defineSandbankApp } from 'sandbank/app-kernel'

export const ${camelCase(id)}App = defineSandbankApp({
  manifestVersion: 1,
  id: '${id}',
  name: '${escapeSingleQuoted(name)}',
  version: '0.1.0',
  backend: {
    kind: '${escapeSingleQuoted(backend)}',
    capabilities: ['files', 'readonlySql', 'branchFirstWrites', 'auditLog'],
    readonlySql: true,
    branchFirstWrites: true,
  },
  objects: [
    defineObject({
      name: 'Record',
      storage: { backend: '${escapeSingleQuoted(backend)}', table: 'records', branchable: true },
      scopes: {
        read: '${scopePrefix}:records:read',
        write: '${scopePrefix}:records:write',
      },
      fields: [
        { name: 'id', type: 'ID', required: true },
        { name: 'title', type: 'String', required: true, filterable: true },
        { name: 'metadata', type: 'JSON' },
      ],
    }),
  ],
  capabilities: [
    defineCapability({
      name: 'records.list',
      object: 'Record',
      operation: 'query',
      requiredScopes: ['${scopePrefix}:records:read'],
      allowedHostKinds: ['web', 'codex', 'cloud_code', 'mcp', 'tool-use'],
      input: [{ name: 'limit', type: 'Int' }],
      output: [{ name: 'records', type: 'JSON', list: true }],
    }),
    defineCapability({
      name: 'records.proposeChange',
      object: 'Record',
      operation: 'mutation',
      requiredScopes: ['${scopePrefix}:records:write'],
      allowedHostKinds: ['web', 'codex', 'cloud_code', 'mcp', 'tool-use'],
      riskLevel: 'high',
      approval: { mode: 'on_high_risk', reason: 'Record writes run through branch-first approval.' },
      input: [{ name: 'changes', type: 'JSON', required: true }],
      output: [{ name: 'proposalId', type: 'ID', required: true }],
    }),
  ],
  views: [
    {
      name: 'record.list',
      object: 'Record',
      fields: ['id', 'title', 'metadata'],
      actions: ['records.list', 'records.proposeChange'],
    },
  ],
})
`,
    'README.md': `# ${name}

This app uses Sandbank App Kernel contracts. The same capabilities can be
projected into the Web chat agent, Codex or Cloud Code tools, MCP, and CLI
without writing a separate API for each host.
`,
  }
  return { id, name, files }
}

function projectCapability(capability: SandbankCapabilityDefinition): SandbankCapabilityProjection {
  return {
    name: capability.name,
    title: capability.title ?? capability.name,
    operation: capability.operation,
    object: capability.object,
    requiredScopes: capability.requiredScopes ?? [],
    riskLevel: capability.riskLevel ?? 'low',
    requiresApproval: capabilityRequiresApproval(capability),
    hosts: capability.allowedHostKinds ?? ['web', 'codex', 'cloud_code', 'mcp', 'cli', 'tool-use'],
    actors: capability.allowedActorKinds ?? ['user', 'agent', 'service', 'external_app'],
    toolUse: {
      name: capability.name,
      resources: projectCapabilityToToolUseResources(capability),
    },
    input: capability.input,
    output: capability.output,
  }
}

function capabilityRequiresApproval(capability: SandbankCapabilityDefinition): boolean {
  const mode = capability.approval?.mode ?? 'never'
  if (mode === 'never') return false
  if (mode === 'always') return true
  if (mode === 'on_write') return capability.operation === 'mutation' || capability.operation === 'action'
  return riskWeight(capability.riskLevel ?? 'low') >= riskWeight('high')
}

function denied(
  definition: SandbankCapabilityDefinition,
  error: string,
  requiredScopes: string[] = definition.requiredScopes ?? [],
): SandbankCapabilityAuthorization {
  return {
    ok: false,
    capability: definition.name,
    requiredScopes,
    requiresApproval: false,
    error,
    errorCode: 'LOCKED',
  }
}

function createCapabilityAuditEvent(
  appId: string,
  definition: SandbankCapabilityDefinition,
  invocation: SandbankCapabilityInvocation,
  context: SandbankCapabilityContext,
): SandbankCapabilityAuditEvent {
  return {
    type: 'sandbank.capability',
    appId,
    capability: definition.name,
    operation: definition.operation,
    actor: invocation.actor ?? context.actor,
    host: invocation.host ?? context.host,
    runId: context.runId,
    approved: Boolean(invocation.approved ?? context.approved),
    reason: invocation.reason,
    riskLevel: definition.riskLevel ?? 'low',
    timestamp: new Date().toISOString(),
    metadata: { ...context.metadata, ...invocation.metadata },
  }
}

function defaultToolUseCapabilityContext(
  appId: string,
  toolContext: ToolUseExecutionContext,
): SandbankCapabilityContext {
  return {
    appId,
    actor: {
      id: toolContext.agentId,
      kind: 'agent',
      scopes: scopesFromToolUsePolicy(toolContext),
    },
    host: 'tool-use',
    runId: toolContext.runId,
    agentId: toolContext.agentId,
    workspaceId: toolContext.workspaceId,
    approved: toolContext.approved,
  }
}

function scopesFromToolUsePolicy(context: ToolUseExecutionContext): string[] {
  const scopes = new Set<string>()
  for (const resource of context.policy.resources ?? []) {
    if (resource.kind !== 'sandbank.scope') continue
    if (resource.id) scopes.add(resource.id)
    if (resource.scope) scopes.add(resource.scope)
  }
  return [...scopes]
}

function fieldType(field: SandbankFieldDefinition): string {
  const type = field.list ? `[${field.type}]` : field.type
  return field.required ? `${type}!` : type
}

function formatFields(fields: SandbankFieldDefinition[] | undefined): string {
  return (fields ?? []).map(field => `${field.name}: ${fieldType(field)}`).join(', ')
}

function riskWeight(level: SandbankRiskLevel): number {
  switch (level) {
    case 'low': return 1
    case 'medium': return 2
    case 'high': return 3
    case 'critical': return 4
  }
}

function normalizeAppId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(normalized)) {
    throw new WorkspaceError('CONFLICT', 'App id must normalize to lower-kebab-case and 2-63 characters.')
  }
  return normalized
}

function titleFromId(id: string): string {
  return id.split('-').filter(Boolean).map(part => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ')
}

function camelCase(id: string): string {
  const parts = id.split('-').filter(Boolean)
  const [first, ...rest] = parts
  return [
    first ?? 'sandbank',
    ...rest.map(part => part.slice(0, 1).toUpperCase() + part.slice(1)),
  ].join('')
}

function escapeSingleQuoted(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

function simpleDigest(input: string): string {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function randomSuffix(): string {
  const cryptoObject = globalThis.crypto
  if (cryptoObject && 'randomUUID' in cryptoObject) return cryptoObject.randomUUID().slice(0, 8)
  return Math.random().toString(36).slice(2, 10)
}
