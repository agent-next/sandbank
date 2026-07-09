---
name: create-sandbank-ai-app
description: Build a new AI App on the Sandbank App Kernel. Use this whenever the user asks to create, scaffold, migrate, or design an AI App that should run across Web chat, Codex, Cloud Code, MCP, CLI, or DB9/Postgres-compatible workspaces. This skill turns app intent into a Sandbank manifest, capability contract, backend gateway, approval/audit flow, host projections, runnable example, and verification commands.
---

# Create Sandbank AI App

Use this skill to create a new AI App that reuses Sandbank's app kernel instead
of rewriting agent runtime, database access, MCP tools, approval, audit, and
host-specific APIs for every product.

The core shape is:

1. one App Manifest;
2. object and capability definitions;
3. capability handlers for business logic;
4. `WorkspaceAdapter` as durable state;
5. `createDb9WorkspaceGateway` for safe DB9/Postgres-compatible data access;
6. `createToolUseRegistryFromSandbankApp` and host projection metadata for Web,
   Codex, Cloud Code, MCP, CLI, and SDK callers.

## Workflow

### 1. Capture the product shape

Extract these decisions from the user's request or ask only for missing
high-impact details:

- app id and user-facing name;
- primary objects, such as Note, Customer, Project, Artifact, Issue;
- read capabilities, such as `notes.list` or `customers.search`;
- write capabilities, such as `notes.proposeChange`;
- approval boundaries: which operations only create proposals, and which apply
  user-visible changes;
- expected hosts: Web, Codex, Cloud Code, MCP, CLI, SDK;
- backend mode: DB9 default, Postgres-compatible, or local memory for tests.

Keep the app-specific business logic in capability handlers. Keep runtime,
authorization, audit, approval, workspace persistence, and host projection in
Sandbank primitives.

### 2. Scaffold the app

Prefer the repository CLI when available:

```bash
pnpm --filter sandbank exec sandbank create app <app-id> --out <target-dir>
```

The equivalent direct command is:

```bash
pnpm --filter sandbank exec sandbank app scaffold <app-id> --out <target-dir>
```

If the CLI is not built or not convenient, call
`createSandbankAppScaffold()` from `sandbank/app-kernel` and write the same
files manually.

### 3. Write the manifest and capability contract

In `src/sandbank.app.ts`, define:

- `defineSandbankApp({ manifestVersion: 1, id, name, backend, objects, capabilities, views })`;
- one `defineObject()` per durable domain object;
- one `defineCapability()` per operation the app exposes;
- `requiredScopes` for every capability;
- `allowedHostKinds` covering all intended hosts;
- `approval` on high-risk apply operations;
- stable `views` for UI and MCP widget projection.

Use GraphQL-like field shapes to describe inputs and outputs, but do not expose
raw GraphQL or raw SQL as the security boundary. The capability contract is the
ABI. GraphQL concepts are useful for names, typed fields, introspection, and
selection, while Sandbank scopes, approvals, audit, and workspace gateways
remain the enforcement layer.

### 4. Implement handlers through the workspace gateway

Create handlers that receive `SandbankCapabilityContext` and use:

- `createDb9WorkspaceGateway(workspace, { actor, host, runId })`;
- `gateway.listResources()` and `gateway.readResource()` for file-like objects;
- `gateway.queryReadonly()` for safe SELECT/WITH/EXPLAIN inspection;
- `gateway.proposeChange()` for branch-first writes;
- `gateway.applyApprovedChange()` only after approval.

Avoid direct production DML/DDL in handlers. Setup scripts may initialize a real
database, but runtime capabilities should expose app-level operations, not a SQL
console.

### 5. Add host projection

Export helpers that can be used by hosts:

- `createCapabilityRegistry(app)` for direct SDK or Web agent calls;
- `createToolUseRegistryFromSandbankApp(app)` for Codex/Cloud Code-style tool
  execution;
- `projectSandbankApp(app)` for Web/MCP/CLI metadata and view models;
- `printCapabilitySDL(app)` for docs and inspection.

### 6. Wire DB9-compatible verification

Every example app should support two modes:

- **Local DB9-compatible mode**: runs without secrets using a local
  `WorkspaceAdapter` that supports the same safe gateway contract. Mint a
  temporary `mintSandbankScopedToken()` grant for the test actor.
- **Real DB9 mode**: when `DB9_TOKEN` and `DB9_DB_ID` are present, instantiate
  `Db9WorkspaceAdapter`. If the user wants to validate scoped delegation and
  the adapter supports it, call `createScopedToken()` with a short TTL and
  minimal fs9/sql permissions.

Document clearly which mode ran. Do not print real tokens.

### 7. Verify

Run, in this order:

```bash
pnpm --filter <example-package> typecheck
pnpm --filter <example-package> verify
pnpm -r typecheck
pnpm test
```

The example verification should prove:

- the manifest validates;
- the capability registry can execute read and write flows;
- Tool Use projection can execute at least one read capability;
- writes create a proposal before data changes;
- approval is required before applying user-visible changes;
- the final state is readable from the same workspace.

### 8. Update docs

After the example runs, update product docs to describe Sandbank as an AI App
Kernel:

- one capability contract reused across Web chat, Codex, Cloud Code, MCP, CLI,
  and SDK;
- DB9 as the default agent-native backend, with Postgres-compatible fallback;
- branch-first writes, approval, audit, and view models as framework features;
- the example app and commands needed to run it.

## Output checklist

Finish with:

- the skill path;
- the example path;
- the verification commands and results;
- whether real DB9 mode or local DB9-compatible mode was used;
- any remaining production integration work, such as OAuth providers, real DB9
  conformance, MCP server publishing, or Web approval UI.
