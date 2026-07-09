# Sandbank App Kernel 与 agent-native DB 实施报告

日期：2026-07-09
目标仓库：`chekusu/sandbank`
背景：基于一次关于「Sandbank 是否能成为所有 AI App 的基础框架」「对话框 agent 为核心的新 AI app」「Web App / Codex / Claude Code 多 host 运行」「MCP/Skill/UI 多入口投射」「是否应通过 MCP 分权限直接操作数据库」以及「db9.ai 能否成为友好的 agent-native DB」的架构讨论。

## 结论摘要

本报告最终目标不是「让 agent 使用 db9」本身，而是把 Sandbank 定义成一套可复用的 AI App Runtime Framework：

> Sandbank App Kernel = agent run lifecycle + execution runtime + durable workspace + capability contract + host projection + auth/delegation + approval/audit + UI contract。

新的 AI App 不应该重复实现「Agent 在哪里运行」「记忆放在哪里」「Web chat 怎么流式返回」「Codex/Claude Code 怎么调用同一套业务能力」「外部 host 怎么授权」「操作怎么审批、审计、回滚」这些底层逻辑。App 作者应该只需要定义业务对象、capability、handler、权限策略和默认 UI view，然后由 Sandbank 把同一份 contract 投射到 Web App、默认 Agent、MCP、Skill、CLI、SDK 和外部 coding agent。

db9.ai 很有机会成为 Sandbank 体系里友好的 agent-native DB backend，但它当前更准确的定位是：

> agent-optimized Postgres workspace，而不是完整的 agent-native capability gateway。

这不是负面判断。db9 已经把 agent 常见的状态碎片问题压进一个统一后端：结构化表、文件、向量检索、HTTP 调用、cron、branch、skill onboarding 和 observability。对 Sandbank 来说，db9 很适合作为 DB-native workspace / service provider / agent memory backend。

但如果目标是让 Codex、Claude Code、自家 agent、MCP host 乃至产品 UI 都能安全操作业务数据，不能把 raw SQL 或数据库 admin 权限直接交给模型。需要在 db9 之上建立一层 capability gateway：以业务能力为中心定义权限、schema、审批、审计、UI 和 MCP/Skill 投射。

简化判断：

- 适合：agent scratch DB、branch-per-task sandbox、RAG/knowledge workspace、run artifact store、multi-agent shared memory、DB-backed workspace protocol。
- 谨慎：直接操作生产业务库、跨租户业务操作、财务/权限/身份等高风险写操作。
- 缺口：Sandbank App Manifest、Capability SDK、Host Projection Layer、外部 host 授权、branch-first write、语义化 capability registry、一等 MCP server、审批/diff/rollback 工作流、细粒度 agent op log、host-portable UI widgets。

## 0. 目标模式：Sandbank 作为所有 AI App 的基础框架

目标模式是：开发一个新的 AI App 时，应用不再从头编写 agent runtime、chat runtime、workspace runtime、MCP server、Skill 文档、外部 host 授权、sandbox 调度、memory、audit 和 approval，而是使用 Sandbank App Kernel。

Sandbank 负责统一底座：

- Agent run lifecycle：run、trace、retry、checkpoint、rollback、stream event。
- Execution runtime：Dynamic Worker、Sandbank Cloud、BoxLite、E2B、local provider、未来兼容 provider。
- Workspace backend：memory、artifact、files、op log、branch、query、vector/search。
- Capability contract：业务能力如何定义、授权、审批、审计、投射。
- Host adapters：Web App chat、Codex、Claude Code、MCP、CLI、SDK。
- UI contract：chat event、tool result、approval view、diff view、artifact view、run trace view。
- Auth/delegation：human user、default app agent、user-owned Codex、Claude Code、system job、scoped token、短期授权。

新的 AI App 只负责业务逻辑：

- 定义业务对象和资源边界；
- 定义 capability；
- 写 handler；
- 选择默认 UI view；
- 配置权限、审批和审计策略；
- 选择 workspace backend，默认可以是 DB9，也可以是兼容 DB9 能力矩阵的 Postgres-like backend。

推荐开发体验：

```ts
export default defineSandbankApp({
  id: 'crm-agent',
  workspace: {
    backend: 'db9',
    database: 'crm-prod',
  },
  objects: [
    defineObject({
      name: 'Customer',
      fields: {
        id: 'id',
        name: 'string',
        stage: 'string',
        ownerId: 'userId',
      },
      tenantKey: 'workspaceId',
    }),
  ],
  capabilities: [
    defineCapability({
      name: 'customer.update_stage',
      inputSchema,
      outputSchema,
      requiredScopes: ['customer:write'],
      riskLevel: 'medium',
      approvalPolicy: 'external_host_or_bulk',
      auditShape: ['actor', 'host', 'customerId', 'oldStage', 'newStage'],
      view: 'ObjectChangeView',
      handler: async ({ input, actor, workspace }) => {
        // app-specific business logic
      },
    }),
  ],
  hosts: {
    webChat: true,
    mcp: true,
    codexSkill: true,
    cli: true,
    sdk: true,
  },
})
```

这里的「一个 API」不应该是 database API，也不是 raw SQL API，而是 Sandbank 的 Capability Gateway API。所有 host 都通过同一个 gateway 调用同一份 capability contract，只是认证方式、UI 呈现和审批路径不同。

## 1. 更好的产品框架不是「chat agent + 一堆 API」，而是 App Kernel + Capability Contract

如果一个新 AI app 的核心是对话框 agent，并且它需要：

1. 调用全部业务 API；
2. 调用广泛连接器/tools；
3. 在 Codex、Claude Code 等外部聊天框中可用；
4. 把业务包装成 MCP/Skill；
5. 生成符合产品风格的 UI，并能在其他聊天框中生成类似 UI；
6. 跨平台运行；

那么不应该从「agent framework」开始设计，而应该从「capability contract」开始设计。

推荐抽象：

```text
Sandbank App Kernel
  -> Capability Registry
      -> Product App API
      -> Web Chat tools
      -> MCP tools/resources/prompts
      -> Codex / Claude Code Skills
      -> UI widgets / design-system views
      -> CLI / SDK
      -> Audit / approval / evals
```

每个业务能力只定义一次：

```text
name
description
inputSchema
outputSchema
handler
actorKinds
requiredScopes
riskLevel
approvalPolicy
dryRun
idempotency
auditShape
canonicalUI
examples
evals
```

然后从这个 registry 投射到不同入口。这样可以避免产品复杂后出现四套定义：App API 一套、MCP tools 一套、Skill prompt 一套、UI prompt 又一套。

### 1.1 Capability Contract 的必要边界

Capability Contract 不是 CRUD wrapper。它应该表达业务语义，而不是把表、REST endpoint 或 SQL statement 原样暴露给模型。

必须有的边界：

- actor：human user、default app agent、user-owned Codex、Claude Code、system job；
- host：Web App、MCP host、Codex、Claude Code、CLI、SDK；
- subject：当前授权主体；
- resource：业务对象、tenant、workspace、文件、artifact、数据库 view；
- scope：读、写、执行、导出、审批、admin；
- risk：low、medium、high、destructive；
- approval：无审批、策略审批、人类审批、双人审批；
- isolation：readonly、branch-scoped rw、prod write；
- audit：哪些字段必须进入 append-only op log；
- view：返回结果对应的标准 UI view model。

如果这些边界缺失，Sandbank 只是把 API 调用统一了，但没有把 AI App 的安全模型统一。

### 1.2 新 App 不需要少写所有代码，只需要少写重复底座

目标不是让 agent 完全不写业务代码，也不是让 DB9 自动替业务建模。合理边界是：

- Sandbank 生成和托管通用底座：agent run、workspace、memory、artifact、tool use、approval、audit、host projection。
- App 作者定义业务对象和 capability：这部分仍然需要明确，因为它决定了权限、UI、审批、数据不变量。
- DB9/Postgres 承载 durable state：可以减少基础设施表、文件、向量、run log、artifact store、branch sandbox 的重复实现，但不能替代业务语义。

## 2. GraphQL 对 Capability Contract 的借鉴

GraphQL 很适合作为 Sandbank Capability Contract 的参考，但不建议把 Sandbank 的安全边界直接做成裸 GraphQL API。

可以借鉴的部分：

- Schema-first：新 AI App 先声明对象、字段、输入、输出和能力。
- Resolver 模型：外部只看到 capability，内部 handler 可以访问 DB9、Postgres、sandbox、HTTP、memory、secrets。
- Introspection：Web App、MCP host、Codex、Claude Code、CLI 可以发现当前 actor 可用能力。
- Selection set：调用方只请求需要的字段，可减少敏感字段泄漏和 token 浪费。
- Composition：多个业务模块、插件、connector 可以像 federation 一样组合 namespace。

GraphQL 不足的部分：

- mutation 默认不表达 risk level；
- 不内置 approval、dry-run、branch-first write；
- introspection 如果直接开放，可能泄漏 schema；
- 容易退化成自动 CRUD，这对 agent 操作业务数据很危险；
- 不区分调用者是在 Web App、Codex、Claude Code、system job，还是用户授权的外部 host。

因此推荐使用 GraphQL-inspired Capability SDL，而不是直接把 GraphQL 作为 agent-facing ABI。

示例：

```ts
defineCapability({
  name: 'customer.update_stage',
  inputSchema,
  outputSchema,
  resultProjection: ['customer.id', 'customer.stage', 'audit.id'],
  requiredScopes: ['customer:write'],
  riskLevel: 'medium',
  approvalPolicy: 'external_host_or_bulk',
  dryRun: true,
  idempotencyKey: input => `customer-stage:${input.customerId}:${input.stage}`,
  auditShape: ['actor', 'host', 'customerId', 'oldStage', 'newStage'],
  view: 'ObjectChangeView',
  handler,
})
```

Sandbank 可以从这份 contract 自动生成：

- Web App tool；
- MCP tool / resource / prompt；
- Codex / Claude Code Skill 文档；
- CLI command；
- typed SDK method；
- approval UI；
- audit log schema；
- eval case。

## 3. MCP 是外部 ABI，不是业务内核

MCP 适合作为 agent 访问外部系统的协议边界。它可以暴露 tools、resources、prompts，也适合作为跨 ChatGPT/Codex/Claude/Cursor 等 host 的接入层。

但 MCP 本身不解决这些问题：

- 哪些操作是业务语义能力；
- 哪些写操作必须审批；
- 一个模型生成的 SQL 是否符合业务不变量；
- 一个 UI 是否符合产品设计系统；
- 一个 agent 是否只能为了当前 task 使用某项权限；
- 操作失败如何回滚；
- 审计应该记录哪些上下文。

因此，MCP server 应该是 capability registry 的 projection，而不是把 REST API 或 SQL endpoint 原样暴露出去。

## 4. 通过 MCP 直接操作数据库：可以，但不能是裸 SQL

「App 最终都变成各种模型从各种入口操作业务 API」这个判断基本成立。但从这里不能推出「让 MCP 直接操作数据库」等于「暴露 raw SQL」。

更合理的东西是：

> DB-native capability gateway

它应该把数据库能力封装成语义化、可审批、可审计、可回滚的操作。

### 推荐边界

读操作：

- 暴露 curated views，而不是全库；
- 支持 schema introspection，但默认脱敏；
- 支持 row-level security、column masking、tenant isolation；
- 支持 `purpose` / `task` / `subject` 进入策略判断。

写操作：

- 不开放任意 `INSERT/UPDATE/DELETE` 作为默认工具；
- 高风险写操作必须先 `dry_run`；
- 返回 diff / affected rows / rollback plan；
- 人类或策略引擎审批后才 apply；
- 默认在 branch 上试跑，通过后再 promote 或生成 migration；
- 每次操作写入 append-only op log。

危险能力：

- `DROP`、`TRUNCATE`、大规模 `UPDATE`、权限变更、credential 读取、外部 HTTP 调用，应有独立 risk level；
- raw SQL 只保留给 admin/debug 模式；
- agent 默认使用 scoped read-only 或 branch-scoped rw token。

## 5. db9.ai 当前为什么接近 agent-native DB

db9 的公开定位是「Postgres but for agents」。从公开文档和 skill 看，它已经具备几个很强的 agent-friendly 特征。

### 5.1 统一 agent state/backend

db9 把以下能力放进一个 Postgres-compatible 后端：

- 表和 JSONB：结构化状态；
- pgvector-compatible vector：语义检索；
- fs9：文件、日志、artifact、CSV/JSONL/Parquet；
- HTTP from SQL：外部 enrichment/webhook/API；
- pg_cron：周期任务；
- branch：安全实验和 preview；
- observability：query samples、slow queries、errors、schema introspection；
- SDK/CLI：agent 可脚本化使用。

这直接解决 agent state fragmentation：过去需要 Postgres + object storage + vector DB + worker + cron，现在可以先用一个后端承载大部分 workspace 状态。

### 5.2 Branch 对 agent 很关键

db9 branch 可以给一个 database 创建独立 copy，拥有自己的 credentials、connection string、storage keyspace 和生命周期。对 agent 来说，这就是天然的 risky operation sandbox。

推荐默认模式：

```text
production DB
  -> task branch
      -> agent runs schema/data changes
      -> inspect diff and tests
      -> approve
      -> apply migration/promote result
      -> delete branch
```

这比让 agent 直接在生产库上执行改表/改数据安全得多。

### 5.3 Skill onboarding 已经证明它理解 agent 入口

db9 提供 `db9 onboard`，可以把 skill 安装到 Claude Code、Codex、OpenCode 和 generic `.agents` 目录。Codex 文档说明该 skill 会教 agent 使用 `db9` CLI 和 SQL 来创建数据库、查询、文件、branch、cron、extensions 和 auth。

这很好，但它仍然是「Skill + CLI」。Skill 是操作手册，不是权限边界；CLI 是工具入口，不是 host-portable MCP contract。

### 5.4 权限基础存在，但还不是完整 agent 权限模型

db9 已有：

- bearer tokens；
- scoped tokens；
- connect tokens；
- roles；
- Row-Level Security；
- BYO JWT；
- credential hashing/encryption说明；
- privilege-changing audit trail。

这些是 agent-native gateway 的底座。但 agent 权限还需要更高一层：

```text
subject: 哪个用户/agent
task: 当前任务是什么
purpose: 为什么要访问
capability: 调用哪个业务能力
object: 影响哪些对象/租户/表/文件
risk: 风险级别
approval: 是否需要审批
trace: 与哪个 conversation/run 关联
```

RLS 解决的是「这一行能不能看/改」，但不等于「这次业务操作是否应该由这个 agent 执行」。

## 6. 当前缺口与风险

### 6.1 公开资料里未看到官方一等 MCP server

当前公开文档重点是 CLI、SDK、Skill、Postgres wire protocol 和 REST API。对 Sandbank 的 agent-native 目标来说，下一步应是官方或内部实现一个 MCP server：

- `resources/list`：列出 databases、branches、schemas、views、files、runs；
- `resources/read`：读取 schema、sample rows、query plans、artifact、run log；
- `tools/call`：执行安全的 capability tools；
- `_meta.ui.resourceUri`：把 query result、diff、approval、branch status 渲染成 widget；
- server instructions：描述安全策略、默认 branch-first、禁止 raw prod write。

没有 MCP server 的情况下，Codex/Claude 可以靠 Skill + CLI 使用 db9，但跨 host 的工具发现、权限提示、UI 渲染和审批一致性会弱。

### 6.2 raw SQL 是优势也是风险

「LLM 会 SQL」是 db9 的强点。它降低学习成本，也让 agent 可以直接用强大的关系模型处理数据。

但 raw SQL 对生产业务是危险的默认接口：

- 模型可能漏掉 tenant filter；
- 可能绕过业务状态机；
- 可能写出过宽的 `UPDATE`；
- 可能在不该调用 HTTP 的地方调用外部接口；
- 可能用 admin role 绕过 RLS；
- 很难把用户意图映射到业务审批。

所以 raw SQL 应该是 backend primitive，而不是默认 exposed capability。

### 6.3 审计粒度还不够 agent-native

db9 文档说明 privilege-changing operations 有 audit trail，例如 token、user、connect key、database lifecycle，默认保留 90 天。

但 agent-native 还需要更细：

- 每次 tool call；
- 每条 SQL 或 SQL plan；
- SQL 由哪个 model/run 生成；
- 影响行数；
- branch diff；
- approval decision；
- rollback handle；
- prompt/task/purpose；
- 调用的外部 HTTP endpoint；
- 读了哪些资源，写了哪些资源。

这些不一定都应该放在 db9 内核里，但 Sandbank 的 gateway 应该补齐。

### 6.4 TLS 文档存在需要实测确认的矛盾

公开资料里有一处明显需要验证：

- `db9.ai/docs/sql/auth/` 写着连接使用 TLS；
- `db9.ai/docs/platform/security-and-auth/` 写着 pgwire wire-level TLS 目前不强制；
- `https://db9.ai/skill.md` 也提示 wire-level TLS 当前未强制，生产应使用 VPN/private networking 或 HTTPS API。

在进入生产或承载敏感业务数据前，应以实际连接测试和官方确认结果为准。Sandbank 不应默认把敏感数据通过未确认加密的 pgwire 暴露在公网。

## 7. 对 Sandbank 的推荐架构

### 7.1 App Kernel 分层

```text
Agent Hosts
  Web App chat / default app agent / Codex / Claude Code / ChatGPT Apps / CLI / SDK

Host Projection Layer
  Web chat tools / MCP server / Skill docs / CLI commands / typed SDK / UI widgets

Capability Gateway
  capability registry + policy + auth/delegation + approval + audit + evals

Sandbank Runtime
  agent supervisor + run lifecycle + execution scheduler + runtime bindings

Workspace Protocol
  memory + files + artifacts + op log + branch + query + vector/search + checkpoint

Workspace Backends
  DB9 / Postgres-like backend / D1 + R2 / TigerFS-like backend / custom adapter

Execution Backends
  Dynamic Worker / Sandbank Cloud / BoxLite / E2B / local / future providers
```

db9 不需要承担所有产品语义。它应该做强 backend：durable state、branch、query、file/vector、cron、observability。Sandbank 的 App Kernel 负责把 backend primitive 转成业务 capability，并把 capability 投射给不同 host。

### 7.2 Sandbank App Manifest

每个 AI App 应有一份 Sandbank manifest。它不是普通配置文件，而是 Sandbank 生成 host projection、runtime binding、权限策略和文档的来源。

Manifest 应覆盖：

- app identity：`id`、`name`、`version`、`owner`；
- workspace backend：`db9`、`postgres`、`d1-r2`、`custom`；
- objects/resources：业务对象、tenant key、敏感字段、默认 views；
- capabilities：业务能力列表、schema、risk、approval、audit、view；
- hosts：Web chat、MCP、Codex Skill、Claude Code Skill、CLI、SDK；
- auth：OAuth/device code/one-time grant/scoped token；
- runtime bindings：workspace、memory、sandbox、http、secrets、db；
- default agent：model、prompt、tools、memory policy；
- evals：capability eval、policy eval、host projection eval。

### 7.3 Capability SDK

需要把现有 `ToolUseRegistry` 提升为 App-level Capability SDK。`ToolUseRegistry` 适合运行时注册工具，但 Sandbank App Kernel 需要更强的声明式 contract。

建议新增：

```ts
defineSandbankApp()
defineObject()
defineResource()
defineCapability()
defineApprovalPolicy()
defineAuditShape()
defineViewModel()
defineHostProjection()
```

Capability SDK 需要生成：

- runtime handler wrapper；
- input/output validation；
- actor/host-aware authorization；
- dry-run contract；
- branch-first write plan；
- audit event shape；
- MCP tool/resource metadata；
- Codex/Claude Code Skill instructions；
- Web chat tool schema；
- typed SDK method；
- CLI command；
- UI view model binding；
- eval scaffold。

### 7.4 Host Projection Layer

同一份 capability contract 需要投射到多个 host：

- Web App：默认 Agent、chat stream、tool call events、approval UI、artifact/diff view。
- Codex：Skill/runbook、MCP server、short-lived scoped token、workspace resource discovery。
- Claude Code：Skill/runbook、MCP server、same capability policy。
- ChatGPT Apps：MCP tool/resource + `_meta.ui.resourceUri` widget。
- CLI/SDK：human/admin/debug path，但仍走同一套 policy/audit。

Host projection 的原则：

- 所有入口调用同一份 capability handler；
- host 只能影响授权方式和 UI 呈现，不能绕过 policy；
- 外部 host 默认使用 scoped token，不持有 DB9 admin token；
- host-specific 文档从 capability registry 生成，不手写多份互相漂移的说明。

### 7.5 外部 host 授权与 delegation

用户自己的 Codex 或 Claude Code 不等同于 Web App 当前 session。Sandbank 需要一套外部 host 授权流程：

- OAuth 或 device code 绑定外部 host；
- one-time grant 允许用户授权某个 task；
- scoped Sandbank token 绑定 `actor`、`host`、`runId`、`capability`、`resource`、`risk`、`expiresAt`；
- token 可换取 DB9 scoped token，但不能直接暴露 DB9 admin token；
- 所有 token mint、refresh、revoke 写入 audit log；
- 高风险 capability 在外部 host 中默认需要 approval；
- 外部 host 的 introspection 只返回当前 token 可见 capability。

### 7.6 Workspace backend 能力矩阵

DB9 是默认强 backend，但 Sandbank 协议不能绑定死在 DB9 私有实现上。每个 backend 需要声明 capability matrix：

```text
files
sql_readonly
sql_write_branch
branch
diff
checkpoint
rollback
vector_search
fts_search
function_runtime
cron
watch
scoped_token
http_from_sql
observability
```

新的 AI App 可以选择 backend，但 Sandbank 只在 backend 声明支持时启用对应 capability。缺失能力应有 fallback 或显式不可用，而不是静默降级成不安全的 raw SQL。

### 7.7 Sandbank MCP server 的建议工具面

第一批不要做 50 个 DB 操作。建议从少量高语义 tools 开始：

```text
workspace_describe
workspace_list_resources
workspace_read_resource
workspace_query_readonly
workspace_create_branch
workspace_run_on_branch
workspace_diff_branch
workspace_propose_migration
workspace_apply_approved_change
workspace_record_memory
workspace_retrieve_context
workspace_export_artifact
```

默认策略：

- prod database 默认 readonly；
- schema/data write 默认 branch-first；
- destructive 操作必须 approval；
- `workspace_query_raw_sql` 只给 admin mode；
- 所有工具返回 structuredContent，方便 UI widget 渲染。

### 7.8 UI 契约

不要让模型临场自由生成数据库 UI。应定义固定 view models：

```text
DatabaseSummaryView
SchemaExplorerView
QueryResultView
BranchDiffView
ApprovalRequestView
RunTraceView
MemorySearchView
ArtifactBrowserView
ObjectChangeView
ObjectEditorView
CapabilityResultView
```

在支持 MCP Apps 的 host 中使用 widget iframe + bridge；不支持的 host 中退化为 Markdown table、CSV、JSON artifact 或文件链接。

### 7.9 权限策略

推荐 capability policy：

```text
read_schema: allowed by scoped ro token
query_view: allowed with row/column policy
query_raw: admin/debug only
write_branch: allowed for task branch
write_prod: approval required
ddl_branch: allowed with migration plan
ddl_prod: approval + migration check required
http_from_sql: endpoint allowlist required
cron_create: approval required
credential_read: denied by default
token_create: human/admin only
```

### 7.10 与现有 Sandbank db9 包的关系

现有 `packages/db9` 和旧的 Service Layer 调研已经把 db9 作为 service provider 考虑进来。新的判断不是替代它，而是把层级说清楚：

- `@sandbank.dev/db9`：provider/backend adapter；
- `Service Layer`：创建/绑定/注入 database service；
- `Workspace Protocol`：把 DB/files/artifacts/op log 变成 agent workspace；
- `Capability Gateway`：把业务语义、安全策略、MCP、UI、approval 合并成外部 ABI；
- `Sandbank App Kernel`：把 manifest、capability SDK、runtime、host projection、auth/delegation 和 workspace backend 统一成新 AI App 的基础框架。

## 8. 实施任务列表与执行路线

当前仓库已经有一些可复用基础：

- `@sandbank.dev/workspace`：Workspace protocol、Memory adapter、checkpoint、sandbox materialize/sync。
- `@sandbank.dev/db9`：DB9 service adapter、DB9 client、DB9 workspace adapter、fs9/search/function/scoped token/branch 入口。
- `sandbank` package：AgentSupervisor、ToolUseRegistry、Dynamic Worker capsule、provider scheduler、DB-native harness API。
- `sandbank workspace` CLI：本地 MemoryWorkspaceAdapter store 的 inspect/list/read/write/watch/checkpoint。

缺口是：这些能力还没有被收敛成 App-level manifest + Capability SDK + Host Projection Layer。下面的路线按这个目标推进。

### Phase 0：目标对齐与现有代码固化

目标：把现有 repo 能力和 App Kernel 目标对齐，避免后续实现偏成单点 db9 工具。

- 在 `docs/plans` 中保留本报告作为主实施报告；
- 在 `docs/TODO.md` 或后续 plan 中拆出 milestone；
- 标注当前 `ToolUseRegistry` 是 runtime tool registry，不等同于 App-level Capability Registry；
- 标注当前 `Db9WorkspaceAdapter.query({ sql })` 是 backend primitive，不应直接成为 app-facing default capability；
- 增加文档说明：Sandbank App Kernel 的默认 backend 是 DB9，但协议必须支持 Postgres-like backend 能力矩阵。

验收：

- 文档明确「Sandbank App Kernel」是目标；
- 文档明确「Capability Gateway API」是一 API，不是 SQL API；
- 文档明确新 AI App 的最小接入方式。

### Phase 1：Sandbank App Manifest

目标：让一个新 AI App 能以 manifest 声明 app identity、workspace backend、objects、capabilities、hosts、auth、runtime bindings。

任务：

- 新增 `packages/sandbank/src/app-manifest.ts` 或独立 `packages/app-kernel`；
- 定义 `SandbankAppManifest`、`SandbankHostConfig`、`SandbankWorkspaceBackendConfig`；
- 定义 object/resource schema：tenant key、sensitive fields、default view；
- 定义 capability reference：name、schema、risk、approval、audit、view、handler id；
- 支持 manifest validation；
- 支持从 TypeScript builder 生成 JSON manifest；
- 增加单元测试。

验收：

- 可以写出 `defineSandbankApp({ ... })`；
- manifest 能列出 app 暴露给 Web/MCP/Codex/CLI 的能力；
- manifest 不包含 DB9 admin token 或 host-specific secret。

### Phase 2：Capability SDK

目标：把业务能力定义成可验证、可授权、可投射、可审计的 contract。

任务：

- 新增 `defineCapability()`；
- 支持 input/output schema；
- 支持 actorKinds、hostKinds、requiredScopes；
- 支持 riskLevel、approvalPolicy、dryRun、idempotencyKey；
- 支持 auditShape、view、examples、evals；
- 增加 handler wrapper，统一注入 `actor`、`host`、`workspace`、`memory`、`sandbox`、`db`、`http`、`secrets`；
- 将现有 `ToolUseRegistry` 作为 capability runtime projection 的一层，而不是唯一 registry；
- 增加 policy denial、approval required、audit emitted 的测试。

验收：

- 同一 capability 可以投射成 `tool.use` handler；
- capability handler 默认无法越过 actor/host/resource policy；
- 高风险 capability 在外部 host 下默认需要 approval。

### Phase 3：DB9 readonly workspace gateway

目标：先建立 report-only / readonly 的 DB gateway，验证「一 API + 多 host + 统一 audit」的最小闭环。

任务：

- 新增 `workspace_describe`；
- 新增 `workspace_list_resources`；
- 新增 `workspace_read_resource`；
- 新增 `workspace_query_readonly`；
- `workspace_query_readonly` 只允许 curated views 或经过 parser 判定的 SELECT；
- 记录 tool call、SQL digest、rowCount、result summary、actor、host、runId、purpose；
- 输出 Markdown + JSON structured result；
- 禁止 write、DDL、HTTP from SQL、credential 读取；
- 给 DB9 adapter 增加 readonly gateway 测试，不改变 backend primitive 的能力。

验收：

- Web App 默认 Agent 能查 readonly workspace；
- Codex/Claude Code 通过 scoped token 能查同一 gateway；
- audit log 能关联 actor、host、run、capability、SQL digest。

### Phase 4：Host Projection Layer 与外部授权

目标：让同一份 capability contract 在 Web App、MCP、Codex、Claude Code、CLI/SDK 中可用。

任务：

- Web projection：生成 chat tool schema、stream events、approval events；
- MCP projection：生成 tools/resources/prompts，返回 structuredContent；
- Skill projection：生成 Codex/Claude Code Skill/runbook；
- CLI/SDK projection：生成 typed method 和命令；
- 实现 device code 或 one-time grant；
- 实现 scoped Sandbank token；
- 实现 token introspection，只返回当前 token 可用 capability；
- 所有 token mint/revoke 写入 audit log。

验收：

- 同一 capability 能从 Web chat 和 MCP host 调用；
- 外部 host 不持有 DB9 admin token；
- 外部 host introspection 不暴露未授权 schema/capability。

### Phase 5：branch-first write、approval 与 rollback

目标：将写操作从 raw prod write 变成 branch-first 的安全工作流。

任务：

- 新增 `workspace_create_branch`；
- 新增 `workspace_run_on_branch`；
- 新增 `workspace_diff_branch`；
- 新增 `workspace_propose_migration`；
- 新增 `workspace_apply_approved_change`；
- DML/DDL 默认在 task branch 执行；
- 生成 affected rows、schema diff、sample validation、rollback handle；
- destructive 操作必须 approval；
- human approve 后才 apply；
- 所有 apply 写入 append-only op log。

验收：

- agent 不能直接对 prod 执行 DML/DDL；
- branch diff 可被 Web/MCP UI 展示；
- approval/rejection 都有审计记录；
- apply 后有 rollback handle 或明确不可回滚说明。

### Phase 6：UI view model contract

目标：让 Web App 和 MCP Apps 不再让模型临场生成数据库 UI，而是消费固定 view model。

任务：

- 定义 `DatabaseSummaryView`；
- 定义 `SchemaExplorerView`；
- 定义 `QueryResultView`；
- 定义 `BranchDiffView`；
- 定义 `ApprovalRequestView`；
- 定义 `RunTraceView`；
- 定义 `MemorySearchView`；
- 定义 `ArtifactBrowserView`；
- 定义 `ObjectChangeView` / `ObjectEditorView` / `CapabilityResultView`；
- 为不支持 widget 的 host 提供 Markdown/JSON/CSV fallback；
- UI view model 与 audit id、run id、capability id 关联。

验收：

- Web chat 可以展示 query result、approval、branch diff；
- MCP Apps host 可以通过 widget resource 展示同一 view model；
- CLI/Skill fallback 输出稳定 Markdown/JSON。

### Phase 7：App scaffold 与 dogfood

目标：验证新 AI App 按 Sandbank scale 接入时，确实不需要重复写底层 runtime。

任务：

- 新增 `sandbank create app`；
- 生成 manifest、capability examples、agent prompt、tests、local dev server、MCP projection；
- 提供 DB9 backend 默认模板；
- 提供 Postgres-like backend adapter placeholder；
- 选择一个内部小 app dogfood，例如 notes、CRM、artifact review 或 issue tracker；
- 用 Web App 默认 Agent 和 Codex/Claude Code 同时调用同一 capability；
- 记录重复代码减少项和仍需手写项。

验收：

- 新 app 能在 1 个 manifest + 若干 capability handler 下跑通；
- Web App 和外部 coding agent 共用同一 capability；
- app 作者不需要手写 MCP server、Skill 文档、approval UI、audit log、sandbox scheduler。

### Phase 8：backend 兼容与能力矩阵

目标：让 DB9 是默认 backend，但不是唯一 backend。

任务：

- 定义 `WorkspaceBackendCapabilities`；
- DB9 adapter 声明完整能力矩阵；
- Postgres-like adapter 声明基础能力矩阵；
- 对缺失 branch/vector/function/watch 的 backend 给出 fallback；
- 增加 conformance tests；
- 文档说明每个 backend 对 App Kernel 功能的影响。

验收：

- DB9 backend 支持完整 DB-native harness；
- 非 DB9 backend 可以运行基础 App Kernel；
- 缺失能力不会静默降级为不安全 raw SQL。

## 9. 最终判断

Sandbank 的目标应该提升为 AI App Runtime Framework，而不是只做 sandbox SDK、DB9 adapter 或 MCP wrapper。它应该成为所有 AI App 复用的 App Kernel：

- 新 App 用 manifest 描述 app；
- 用 Capability SDK 描述业务能力；
- 用 Workspace Protocol 统一 memory、artifact、op log、branch、query；
- 用 Host Projection Layer 暴露给 Web App、Codex、Claude Code、MCP、CLI、SDK；
- 用统一 auth/delegation、approval、audit、view model 控制所有入口。

db9.ai 可以成为这个 App Kernel 的默认 agent-native DB backend，而且方向很对。它的强项不是「Postgres-compatible」这个标签本身，而是它把 agent 需要的 workspace 原语集中在一个数据库后端里：

- state；
- files；
- vectors；
- branch；
- cron；
- SQL；
- observability；
- skills。

但「agent-native DB」不能止步于「让 agent 会用 SQL」。「一个 API」也不能等价于一个 SQL endpoint。真正可维护、可跨 host、可用于业务数据的形态应该是：

> Sandbank App Kernel as AI App runtime + Capability Gateway API as ABI + DB9/Postgres as durable workspace backend。

因此，短期推荐先做 App Manifest、Capability SDK 和 DB9 readonly gateway；中期实现 host projection、外部 host 授权、branch-first write、approval 和 UI view model；长期再把业务 API、数据库、UI、Skill、MCP、CLI、SDK、approval 和 evals 全部收敛到同一份 capability contract。

## 参考资料

- DB9: https://db9.ai/
- Why DB9 for AI Agents: https://db9.ai/docs/why-db9-for-ai-agents/
- DB9 with OpenAI Codex: https://db9.ai/docs/agent-workflows/openai-codex/
- Install DB9 Skills: https://db9.ai/docs/agent-workflows/install-db9-skills/
- DB9 Security and Auth: https://db9.ai/docs/platform/security-and-auth/
- DB9 Row-Level Security: https://db9.ai/docs/sql/rls/
- DB9 Authentication and Roles: https://db9.ai/docs/sql/auth/
- DB9 Branching Workflows: https://db9.ai/docs/guides/branching-workflows/
- DB9 Observability: https://db9.ai/docs/platform/observability/
- DB9 Skill: https://db9.ai/skill.md
- MCP Introduction: https://modelcontextprotocol.io/docs/getting-started/intro
- OpenAI Apps SDK MCP server guide: https://developers.openai.com/apps-sdk/build/mcp-server
- OpenAI Apps SDK MCP Apps compatibility: https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
- GraphQL Specification: https://spec.graphql.org/
- GraphQL Introspection: https://graphql.org/learn/introspection/
