# Agent-native DB 与 db9.ai 判断报告

日期：2026-07-09
目标仓库：`chekusu/sandbank`
背景：基于一次关于「对话框 agent 为核心的新 AI app」「MCP/Skill/UI 多入口投射」「是否应通过 MCP 分权限直接操作数据库」以及「db9.ai 能否成为友好的 agent-native DB」的架构讨论。

## 结论摘要

db9.ai 很有机会成为 Sandbank 体系里友好的 agent-native DB backend，但它当前更准确的定位是：

> agent-optimized Postgres workspace，而不是完整的 agent-native capability gateway。

这不是负面判断。db9 已经把 agent 常见的状态碎片问题压进一个统一后端：结构化表、文件、向量检索、HTTP 调用、cron、branch、skill onboarding 和 observability。对 Sandbank 来说，db9 很适合作为 DB-native workspace / service provider / agent memory backend。

但如果目标是让 Codex、Claude Code、自家 agent、MCP host 乃至产品 UI 都能安全操作业务数据，不能把 raw SQL 或数据库 admin 权限直接交给模型。需要在 db9 之上建立一层 capability gateway：以业务能力为中心定义权限、schema、审批、审计、UI 和 MCP/Skill 投射。

简化判断：

- 适合：agent scratch DB、branch-per-task sandbox、RAG/knowledge workspace、run artifact store、multi-agent shared memory、DB-backed workspace protocol。
- 谨慎：直接操作生产业务库、跨租户业务操作、财务/权限/身份等高风险写操作。
- 缺口：一等 MCP server、语义化 capability registry、审批/diff/rollback 工作流、细粒度 agent op log、host-portable UI widgets。

## 1. 更好的产品框架不是「chat agent + 一堆 API」

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
Capability Kernel
  -> Product App API
  -> MCP tools/resources/prompts
  -> Skills / runbooks
  -> UI widgets / design-system views
  -> CLI / SDK
  -> Audit / approval / evals
```

每个业务能力只定义一次：

```text
name
inputSchema
outputSchema
handler
requiredScopes
riskLevel
approvalPolicy
idempotency
auditShape
canonicalUI
examples
evals
```

然后从这个 registry 投射到不同入口。这样可以避免产品复杂后出现四套定义：App API 一套、MCP tools 一套、Skill prompt 一套、UI prompt 又一套。

## 2. MCP 是外部 ABI，不是业务内核

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

## 3. 通过 MCP 直接操作数据库：可以，但不能是裸 SQL

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

## 4. db9.ai 当前为什么接近 agent-native DB

db9 的公开定位是「Postgres but for agents」。从公开文档和 skill 看，它已经具备几个很强的 agent-friendly 特征。

### 4.1 统一 agent state/backend

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

### 4.2 Branch 对 agent 很关键

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

### 4.3 Skill onboarding 已经证明它理解 agent 入口

db9 提供 `db9 onboard`，可以把 skill 安装到 Claude Code、Codex、OpenCode 和 generic `.agents` 目录。Codex 文档说明该 skill 会教 agent 使用 `db9` CLI 和 SQL 来创建数据库、查询、文件、branch、cron、extensions 和 auth。

这很好，但它仍然是「Skill + CLI」。Skill 是操作手册，不是权限边界；CLI 是工具入口，不是 host-portable MCP contract。

### 4.4 权限基础存在，但还不是完整 agent 权限模型

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

## 5. 当前缺口与风险

### 5.1 公开资料里未看到官方一等 MCP server

当前公开文档重点是 CLI、SDK、Skill、Postgres wire protocol 和 REST API。对 Sandbank 的 agent-native 目标来说，下一步应是官方或内部实现一个 MCP server：

- `resources/list`：列出 databases、branches、schemas、views、files、runs；
- `resources/read`：读取 schema、sample rows、query plans、artifact、run log；
- `tools/call`：执行安全的 capability tools；
- `_meta.ui.resourceUri`：把 query result、diff、approval、branch status 渲染成 widget；
- server instructions：描述安全策略、默认 branch-first、禁止 raw prod write。

没有 MCP server 的情况下，Codex/Claude 可以靠 Skill + CLI 使用 db9，但跨 host 的工具发现、权限提示、UI 渲染和审批一致性会弱。

### 5.2 raw SQL 是优势也是风险

「LLM 会 SQL」是 db9 的强点。它降低学习成本，也让 agent 可以直接用强大的关系模型处理数据。

但 raw SQL 对生产业务是危险的默认接口：

- 模型可能漏掉 tenant filter；
- 可能绕过业务状态机；
- 可能写出过宽的 `UPDATE`；
- 可能在不该调用 HTTP 的地方调用外部接口；
- 可能用 admin role 绕过 RLS；
- 很难把用户意图映射到业务审批。

所以 raw SQL 应该是 backend primitive，而不是默认 exposed capability。

### 5.3 审计粒度还不够 agent-native

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

### 5.4 TLS 文档存在需要实测确认的矛盾

公开资料里有一处明显需要验证：

- `db9.ai/docs/sql/auth/` 写着连接使用 TLS；
- `db9.ai/docs/platform/security-and-auth/` 写着 pgwire wire-level TLS 目前不强制；
- `https://db9.ai/skill.md` 也提示 wire-level TLS 当前未强制，生产应使用 VPN/private networking 或 HTTPS API。

在进入生产或承载敏感业务数据前，应以实际连接测试和官方确认结果为准。Sandbank 不应默认把敏感数据通过未确认加密的 pgwire 暴露在公网。

## 6. 对 Sandbank 的推荐架构

### 6.1 三层分工

```text
Agent Host
  Codex / Claude Code / Sandbank UI / ChatGPT Apps / internal agent

Capability Gateway
  MCP server + REST/SDK + policy + audit + approval + UI widgets

DB9 Backend
  Postgres-compatible DB + fs9 + vector + branch + cron + functions
```

db9 不需要承担所有产品语义。它应该做强 backend：durable state、branch、query、file/vector、cron、observability。Sandbank 的 gateway 负责把这些 backend primitive 转成业务 capability。

### 6.2 Sandbank MCP server 的建议工具面

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

### 6.3 UI 契约

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
```

在支持 MCP Apps 的 host 中使用 widget iframe + bridge；不支持的 host 中退化为 Markdown table、CSV、JSON artifact 或文件链接。

### 6.4 权限策略

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

### 6.5 与现有 Sandbank db9 包的关系

现有 `packages/db9` 和旧的 Service Layer 调研已经把 db9 作为 service provider 考虑进来。新的判断不是替代它，而是把层级说清楚：

- `@sandbank.dev/db9`：provider/backend adapter；
- `Service Layer`：创建/绑定/注入 database service；
- `Workspace Protocol`：把 DB/files/artifacts/op log 变成 agent workspace；
- `Capability Gateway`：把业务语义、安全策略、MCP、UI、approval 合并成外部 ABI。

## 7. 最小可行路线

### Phase 1：内部 report-only / readonly gateway

- 选择一个非生产 db9 database；
- 建立 `workspace_describe`、`workspace_query_readonly`、`workspace_read_file`；
- 记录 tool call / SQL / result summary；
- 输出 Markdown + JSON structured result；
- 禁止 write。

### Phase 2：branch-first write

- 增加 `workspace_create_branch`；
- 所有 DDL/DML 在 branch 执行；
- 生成 affected rows、schema diff、sample validation；
- 不支持自动 merge，先产出 migration proposal。

### Phase 3：approval + MCP UI

- 增加 approval request model；
- 增加 BranchDiffView / QueryResultView widget；
- 支持 human approve 后 apply；
- 所有 apply 写入 op log。

### Phase 4：业务 capability registry

- 把常见业务操作从 SQL 提升成 capability；
- 为每个 capability 定义 schema、scope、risk、approval、audit、UI；
- MCP tools 从 capability registry 自动生成。

## 8. 最终判断

db9.ai 可以成为 Sandbank 的 agent-native DB backend，而且方向很对。它的强项不是「Postgres-compatible」这个标签本身，而是它把 agent 需要的 workspace 原语集中在一个数据库后端里：

- state；
- files；
- vectors；
- branch；
- cron；
- SQL；
- observability；
- skills。

但「agent-native DB」不能止步于「让 agent 会用 SQL」。真正可维护、可跨 host、可用于业务数据的形态应该是：

> db9 as durable backend + Sandbank capability gateway as agent-native ABI。

因此，短期推荐使用 db9 承载 Sandbank 的 DB-native workspace 和 service layer；中期实现 MCP/capability gateway；长期再把业务 API、数据库、UI、Skill、MCP 和 approval 全部收敛到同一份 capability contract。

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
