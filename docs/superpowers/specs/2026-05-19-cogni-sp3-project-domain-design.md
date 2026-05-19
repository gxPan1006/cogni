# Cogni — SP-3「项目域 + Codex adapter」设计文档

> 日期:2026-05-19
> 状态:已通过头脑风暴评审,待评审 spec 后进入实现计划

---

## 一、范围

SP-1 把脊梁打通(账户 + Neon + Runner 抽象 + 云↔桌面 host),SP-2 长出账户合并 / 多端同步 / multi-host / 瘦客户端。SP-3 在这之上**第一次新增业务域**:把 cogni 从"对话助手"扩展为**"监督式 AI worker 编排器"**。

| # | 模块 | 目的 |
|---|---|---|
| 1 | **项目域** (cloud + DB + UI 接线) | 用户在桌面/web 创建项目,在看板里管理一组 task;每个 task 是一个 git worktree 里跑的 runner 进程,生命周期 `queued → running → needs-input → reviewing → done|failed|cancelled`;reconcile loop 持续把 task 朝声明状态推进 |
| 2 | **Codex adapter** (runner-host 新 adapter) | 第二个 `RunnerAdapter` 实现 — 验证 SP-1 抽象在不同 runner CLI(Codex vs Claude Code)间真的可换;每个 task 创建时可选 adapter |
| 3 | **Per-task git workspace** (host RPC) | 项目根仓库 + 每 task 一个 sticky worktree(`task/<ref>` 分支);host 提供 `worktree-create/remove`、`merge-to-main`、`tests-run`、`diff-snapshot`、`fs-browse` RPC;mergePolicy 决定 done 后是否要人审 |
| 4 | **Permission 模型简化** (清 SP-2 留尾巴) | runner sandbox 全权放开(`--dangerously-skip-permissions` / `--sandbox danger-full-access`),不弹"Allow/Deny";SP-2 留下的 `<PermissionPrompt>` 占位 + Conversation.tsx 里 SP-3 占位 callback **删除**;`needs-input` state 重新赋义为"runner 主动问了业务问题,等用户在抽屉里回消息" |

### 前端在 SP-1 / PR #11 已经落地的部分(SP-3 不重写)

通过 PR #11 (`f9dfcce`),桌面前端**已经按最终设计完整画好**,以 mock 数据驱动:

| 文件 | 内容 |
|---|---|
| `apps/desktop/src/ProjectsList.tsx` (+css) | 项目列表 + 卡片网格 + 健康点 + pinned / 已归档区 |
| `apps/desktop/src/Project.tsx` (+css) | 项目看板,columns/swarm/timeline 三视图,breadcrumb,toolbar 新任务/项目设置,needs-input pulse,clickable cards → drawer |
| `apps/desktop/src/TaskDetail.tsx` (+css) | 右侧抽屉,header + state stepper + activity 区 + 嵌入 `<ChatBlocks>` 渲染 thread + Accept/Reject/Retry/取消按钮 |
| `apps/desktop/src/NewProject.tsx` (+css) | 新建项目 modal:名称/描述/source(linear/internal/manual 三选一,**仅 UI 占位**)/默认 host/并发上限(1-16,默认 2)/system prompt |
| `apps/desktop/src/NewTask.tsx` (+css) | 新任务 modal,3 tab:手动 / 从 Linear 拉(mock 数据) / 上传 backlog 文件(UI 即可) |
| `apps/desktop/src/ProjectSettings.tsx` (+css) | 项目设置,5 sections:basics/source/runner/prompt/danger |
| `packages/ui/src/components/Sidebar.tsx` | Mode-aware:project mode 显示项目列表(replace Recents/Pinned) + needs-input badges + 底部 HOSTS 不变 |
| `apps/desktop/src/Shell.tsx` | page state 已扩展 chat/settings/projects/project/project-settings,挂载 modal at root |
| `apps/desktop/src/mock.ts` | 加 `DesignProject` / `MOCK_PROJECTS` / `MOCK_TASK_THREADS` |

**SP-3 实施时**,前端组件**视觉零改**,只做:
- 把组件从 `apps/desktop/src/` 抽到 `packages/ui/src/components/project/` 共享层,让 web 端也能 import
- 把 `MOCK_*` 引用换成真 API hooks (`useProjects` / `useProjectTasks` / `useTaskDetail`)
- 在 `Shell.tsx` / `apps/web/src/App.tsx` 把 console.log 的 onCreate / onAction 接到真 `ApiClient` 方法
- 删 SP-2 留尾巴的 `<PermissionPrompt>` 调用点

### 明确不做(YAGNI)

| 类别 | 不做 | 推到 |
|---|---|---|
| **Permission** | 中途授权 prompt / "Allow once/always/Deny" 流 / `POST /permissions/:reqId` 路由 / `<PermissionPrompt>` UI | SP-3+1 / 永不做 (设计上选择信任 sandbox) |
| **AI 对话创建 task** | 项目级 Workspace Chat 面板 / `cogni__create_task` runner tool / Plan-task LLM endpoint | SP-4 |
| **Tracker 真集成** | Linear OAuth / GraphQL fetch / poll 循环 / 双向 issue 写回。前端 NewTask 的 "从 Linear 拉" tab + ProjectSettings 的 source picker 全部保留为 UI 占位,后端不存 `source` 字段,任何来源创建的 task 等价 | SP-3+1 (单独 epic) |
| **多节点 cogni-cloud** | Redis-backed leader 选举 / reconcile loop 分布式协调 | SP-3+1 |
| **跨 host fan-out** | 项目 task 可被多 host 抢占执行;host 离线时其他 host 接手未跑完 task | SP-4 |
| **Per-task host override** | 单 task 创建时选不同于 project default 的 host | SP-3+1 |
| **第三种 runner adapter** | Aider / Cline / 自家 adapter | SP-4 |
| **artifacts 跨域聚合** | 跨项目搜文件 / artifacts grid / global Recents | SP-4 |

---

## 二、数据模型

DB schema 加 3 张新表,改 1 张已有表加 nullable FK。`events` / `threads` / `messages` 表完全复用。

### A. 新表 `projects`

```sql
projects (
  id              uuid PK
  tenant_id       uuid FK → tenants,
  user_id         uuid FK → users,
  name            text NOT NULL,
  description     text,
  repo_path       text NOT NULL,         -- 绝对路径,在 default_host_id 的本地磁盘
  default_host_id uuid FK → hosts NOT NULL,
  thread_id       uuid FK → threads,     -- 项目级 chat thread (SP-3 当前未用,留给 SP-4 Workspace Chat)
  merge_policy    text NOT NULL DEFAULT 'require-review',
                    -- enum: 'require-review' | 'auto-merge' | 'auto-merge-if-tests-pass'
  test_command    text,                  -- 仅当 merge_policy='auto-merge-if-tests-pass'
  concurrency_limit smallint NOT NULL DEFAULT 2,  -- 项目维度 cap,1-16
  system_prompt   text,                  -- 注入到 runner 的额外 system context (前端字段)
  archived_at     timestamptz,           -- 软删除/归档
  created_at, updated_at timestamptz NOT NULL DEFAULT now()
)
```

**索引**:`(tenant_id, user_id, archived_at)` 用于侧栏列表查询;`(default_host_id)` 用于 host 下线后查 affected projects。

### B. 新表 `project_tasks`

```sql
project_tasks (
  id              uuid PK,
  project_id      uuid FK → projects ON DELETE CASCADE,
  ref             text NOT NULL,         -- project-scoped 短码 "MYAPP-1",自增
  title           text NOT NULL,
  description     text,
  state           text NOT NULL DEFAULT 'queued',
                    -- enum: 'queued' | 'running' | 'needs-input' | 'reviewing' | 'done' | 'failed' | 'cancelled'
  priority        smallint NOT NULL DEFAULT 0,
                    -- 0=none, 1=urgent, 2=high, 3=medium, 4=low (Linear-borrowed)
  labels          text[] NOT NULL DEFAULT '{}',
  order_index     numeric NOT NULL,      -- 看板手动拖拽排序 (lex order)
  host_id         uuid FK → hosts,       -- queued 时 NULL;running 后填上 sticky 不变
  adapter         text,                  -- 'claude-code' | 'codex',NULL 表示用 project 当前默认
  worktree_path   text,                  -- 绝对路径,running 后填;reviewing 仍存在;done/failed 清空
  branch_name     text,                  -- "task/<lowercase-ref>"
  execution_thread_id uuid FK → threads, -- runner 事件流写这里,UI 抽屉读这里
  retries         smallint NOT NULL DEFAULT 0,
  max_retries     smallint NOT NULL DEFAULT 3,
  needs_input_what text,                 -- 当 state='needs-input' 时,runner 抛出的一句话提示
  created_at, updated_at timestamptz NOT NULL DEFAULT now(),
  started_at, completed_at timestamptz
)
```

**索引**:`(project_id, state, order_index)` 用于看板查询;`(host_id, state)` 用于 host 离线时检索 affected tasks;`UNIQUE (project_id, ref)` 自增保护。

**`ref` 自增策略**:用 PG sequence per project — 创建项目时 `CREATE SEQUENCE proj_<id>_seq`,project_tasks INSERT 时取 `nextval`,前缀来自 `projects.name` 缩写(创建项目时计算)。

### C. 新表 `task_runs`

每次 task 启动(首次/重试/host 重连续 session) = 一行,审计追溯 + 抽屉里"重试历史"列表用。

```sql
task_runs (
  id                  uuid PK,
  task_id             uuid FK → project_tasks ON DELETE CASCADE,
  runner_session_id   uuid FK → runner_sessions,  -- SP-1 已有
  attempt_number      smallint NOT NULL,           -- 1-indexed,同 task 内累加
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  exit_reason         text,
                       -- enum: 'done' | 'failed' | 'timeout' | 'host-disconnect' | 'cancelled' | 'business-clarification'
  error_message       text
)
```

**Resume vs Retry**:
- **Resume** (host 重连 / network blip):同一 `task_run`,通过 SP-1 `session-resume` capability 续 runner_session;`attempt_number` 不变
- **Retry** (失败后用户/自动重试):新 `task_run`,新 runner_session;`attempt_number++`;worktree **复用**(sticky)

### D. 改 `runner_sessions`:加 nullable `task_id`

```sql
ALTER TABLE runner_sessions ADD COLUMN task_id uuid REFERENCES project_tasks(id) ON DELETE SET NULL;
```

`task_id IS NULL` = chat 类 session (SP-1/SP-2 已有路径);`task_id IS NOT NULL` = project task session。同一 task 可有多个 runner_session 行(多次 attempt)。

### 保持不变

- `events`:runner 事件按 `thread_id` 写入。SP-3 用 task 的 `execution_thread_id`,fan-out 机制完全复用 SP-2 ClientHub
- `threads`:每个 project_task 拥有一个 `execution_thread_id`;每个 project 拥有一个 `thread_id`(SP-3 暂未使用,SP-4 Workspace Chat 用)
- `messages`:runner 输出 + 用户业务澄清回复都走这里;UI 抽屉嵌入的 `<ChatBlocks>` 直接读

---

## 三、工程结构

### Cloud (`packages/cloud/src/`)

```
domains/
├── chat.ts                       ← SP-1 已有,不动
└── project/                      ← 新
    ├── index.ts                  ← ProjectDomain class,挂在 ServerDeps
    ├── orchestrator.ts           ← reconcile loop (5s tick)
    ├── lifecycle.ts              ← 单点 state machine: 所有 transition 走这里
    ├── merge-gate.ts             ← reviewing → done 的 mergePolicy 处理
    └── ref-allocator.ts          ← project-scoped ref 自增

routes/
├── ... (SP-1/SP-2 已有)
└── projects.ts                   ← 新,完整 REST
```

### Contract (`packages/contract/src/`)

```
protocol.ts                       ← 加 client/server WS messages
host-protocol.ts                  ← 加 cloud→host RPC
types/project.ts                  ← 新,Project / ProjectTask / TaskRun 类型
```

### Runner Host (`packages/runner-host/src/`)

```
git-ops.ts                        ← 新,实现 cloud→host 的 git RPC handler
fs-browse.ts                      ← 新,响应 web NewProject 的目录浏览请求
adapters/
├── claude-code/                  ← SP-1 已有
└── codex/                        ← 新,实现 RunnerAdapter
    ├── index.ts
    └── codex-process.ts          ← Codex CLI 进程包装
```

### UI 共享 (`packages/ui/src/`)

```
components/project/               ← 从 apps/desktop/src/ 提升过来
├── ProjectsList.tsx + .css
├── ProjectBoard.tsx + .css       ← rename 自 Project.tsx (更清晰)
├── TaskDetail.tsx + .css
├── NewProject.tsx + .css
├── NewTask.tsx + .css
└── ProjectSettings.tsx + .css

hooks/
├── useProjects.ts                ← 新,GET /api/projects + WS subscribe-projects
├── useProjectTasks.ts            ← 新,GET /api/projects/:id/tasks + WS subscribe-project
├── useTaskDetail.ts              ← 新,GET task detail + 抽屉打开时订阅 execution_thread
└── useHostFsBrowse.ts            ← 新,只 web 用

transport/api.ts                  ← 新增 projects / tasks methods
```

### Apps

```
apps/desktop/src/
├── Shell.tsx                     ← 改:页签 dispatch 已有,把 onCreate/onAction console.log 改为真调
└── (删除 ProjectsList / Project / TaskDetail / NewProject / NewTask / ProjectSettings 本地副本)

apps/web/src/
├── App.tsx                       ← 改:加 page state for projects/project/project-settings
                                  ←     新建项目 modal 加 "Step 0: 选 host" + 调 host-fs-browse RPC
└── (从 @cogni/ui 拿组件)
```

---

## 四、Lifecycle 状态机

```
                          ┌─────────────┐
                          │   queued    │
                          └─────┬───────┘
                                │ orchestrator dispatch
                                │ (host online + 项目并发未满 cap)
                                ▼
       ┌────────────────────┐  reviewing  ┌─────────────────┐
       │      running       │◄────────────│ (mergePolicy=    │
       │                    │             │  require-review)│
       │  ┌──────────────┐  │             └────────┬────────┘
       │  │ needs-input  │  │                      │ Accept
       │  │ (runner 自己问 │  │                      │
       │  │  业务问题)    │  │                      ▼
       │  └──────┬───────┘  │             ┌───────────────┐
       │         │ 用户回消息 │             │     done      │
       │         ▼          │             └───────────────┘
       │     (back)         │
       └──────┬─────────────┘
              │ runner emit 'done'
              ▼
       ┌─────────────────────┐
       │ mergePolicy switch  │
       │  - auto: merge→done │
       │  - auto-if-tests:   │
       │    run tests → done│
       │    or → reviewing  │
       │  - require-review:  │
       │    → reviewing      │
       └─────────────────────┘

异常分支(任意状态可进):
- failed:  retries < max_retries → 自动 retry (new task_run);否则停 failed
- cancelled: 用户点取消;清 worktree
- host-disconnect: orchestrator 标 failed,触发 retry
```

### needs-input 重新赋义

**SP-3 之前**(SP-2 留尾巴 + 前端 brief 假设):runner 想做敏感操作(写文件 / 跑 shell)→ runner 暂停 → cloud 收 `permission-request` → task 进 `needs-input` → 抽屉显示 Allow/Deny。

**SP-3 之后**:runner sandbox 全权放开,**不会再进 `needs-input` 因为 permission**。但保留状态用于另一个场景:

- **runner 在 task 中途遇到需要用户决策的业务问题** → 在 `execution_thread` 里发一条 assistant 消息(内容为问题) + emit `clarification-request` 事件携带 "what" 字段
- cloud 收到 → task state 变 `needs-input`,`needs_input_what` 填上 runner 那句话
- 看板卡片: `<Project.tsx>` 已经有 needs-input pulse + sidebar badge
- 用户点开抽屉 → 看到 runner 那条消息 → 在 Composer 输入回复 → POST 一条 user 消息到 execution_thread
- cloud lifecycle: 收到 user 消息后 → task state 变 `running`,`needs_input_what` 清空,runner 续 turn

**UI 抽屉里的 "Allow/Deny" 按钮在 SP-3 直接不渲染**(前端代码里 SP-3 实施时清掉)。

---

## 五、Reconcile Loop (Symphony-inspired,单节点)

```ts
// packages/cloud/src/domains/project/orchestrator.ts
class ProjectOrchestrator {
  private intervalHandle?: NodeJS.Timeout;

  start() {
    // 5s tick.SP-3 MVP 单节点 cogni-cloud,无需 leader 选举。
    // SP-3+1 多节点时改为 Redis-locked leader-only tick。
    this.intervalHandle = setInterval(() => void this.tick(), 5000).unref();
  }

  private async tick() {
    // 1. reconcile:扫所有 state='running' 的 task,host 在线 + runner_session 活吗?
    await this.reconcileRunningTasks();
    // 2. dispatch:按 project 分组,在 cap 内启动 queued task
    await this.dispatchQueuedTasks();
    // 3. retry:扫 state='failed' 但 retries < max 的 task,自动重试
    await this.retryFailedTasks();
  }
}
```

### reconcile 细节

对每条 `state='running'` 的 task:
- host 离线(`hosts.last_seen` > 60s 前) → 关 `task_run` 标 `exit_reason='host-disconnect'`,task state → `queued`(等待 retry tick)
- runner_session 状态 `closed` 但 task state 还在 `running`(host 上 runner 已挂但 cloud 没收到 done 事件) → 关 `task_run` 标 `exit_reason='failed'`,task state → `failed`

### dispatch 细节

按 `(project_id, priority desc, order_index asc, created_at asc)` 排:
- 查项目 `concurrency_limit` N
- 查项目当前 `state IN ('running', 'needs-input')` 的 task 数 R
- 在 `N - R` 名额内启动新 task(state 从 queued → running):
  1. 选 host:用 task.host_id 如果有(SP-3+1 per-task override),否则用 `projects.default_host_id`
  2. host 不在线 → 跳过本 tick(下 tick 再试)
  3. 创建 task_run 行(attempt_number = max + 1)
  4. 发 `git-worktree-create` RPC 到 host → host 返回 worktree_path
  5. UPDATE project_tasks SET state='running', host_id=..., worktree_path=..., branch_name=...
  6. 发 `dispatch` 消息到 host(SP-1 已有路径,加 `taskId` 上下文,host 在 cwd=worktree_path 起 runner)

### retry 细节

`state='failed' AND retries < max_retries` 的 task:
- 上次 task_run.ended_at > N 秒前(指数退避:2^attempt 秒)
- → state 回 `queued`,等下 tick dispatch

---

## 六、Cloud HTTP Routes

`packages/cloud/src/routes/projects.ts`:

```
# 项目
GET    /api/projects                         → ProjectSummary[]
POST   /api/projects                         → 创建,body: {name, description?, repoPath, defaultHostId, mergePolicy, testCommand?, concurrencyLimit, systemPrompt?, initGit?: boolean}
GET    /api/projects/:id                     → ProjectDetail
PATCH  /api/projects/:id                     → 更新 settings
DELETE /api/projects/:id                     → 软删除(archived_at=now);active task 标 cancelled

# Task
GET    /api/projects/:id/tasks               → ProjectTask[],query: ?state=...&limit=...
POST   /api/projects/:id/tasks               → 创建,body: {title, description?, priority?, labels?, adapter?}
PATCH  /api/projects/:id/tasks/:taskId       → 编辑字段(title/desc/priority/labels/order_index)
POST   /api/projects/:id/tasks/:taskId/actions
                                             → body: {action: "cancel" | "accept" | "reject" | "retry"}
                                             - cancel: state→cancelled, 杀 runner, 清 worktree
                                             - accept: 仅当 state=reviewing, 执行 merge-to-main, state→done
                                             - reject: 仅当 state=reviewing, 删 worktree+branch, state→failed(reason='rejected')
                                             - retry: 仅当 state=failed, retries++, state→queued

GET    /api/projects/:id/tasks/:taskId/diff  → 触发 host RPC `git-diff-snapshot`,返回 {files:[{path, additions, deletions, patch}]}
GET    /api/projects/:id/tasks/:taskId/runs  → TaskRun[],抽屉里 "重试历史" 用

# Web 端新建项目辅助
POST   /api/hosts/:hostId/fs-browse          → body: {path?: string},触发 host RPC,返回 {entries:[{name,kind,...}]}
```

**Auth**:所有 routes 走 SP-2 已有的 JWT middleware + session 吊销检查。

---

## 七、Host RPC 协议扩展

`packages/contract/src/host-protocol.ts` 加新消息(cloud → host):

```ts
| { t: "git-worktree-create"; taskId; repoPath; branchName; ackId }
| { t: "git-worktree-remove"; worktreePath; ackId }
| { t: "git-merge-to-main"; repoPath; branchName; commitMessage; ackId }
| { t: "git-tests-run"; worktreePath; command; timeoutMs?; ackId }
| { t: "git-diff-snapshot"; worktreePath; ackId }
| { t: "git-init-if-missing"; repoPath; initialReadme?: string; ackId }
| { t: "fs-browse"; path?: string; ackId }     ← web NewProject 用
```

Host → cloud 响应(沿用现有 `git-ack` 模式 + 各 op 专属 result frame)。

### 不变量(借鉴 Symphony §3.6 安全条款)

1. `worktreePath` **必须**在 `repoPath` 的祖先目录下;host 校验,否则拒绝执行
2. `repoPath` 在 host 上**必须**已是 git 仓库(或 `git-init-if-missing` 处理过);执行 `git rev-parse` 验证
3. runner 进程的 `cwd` **必须**等于其 task 的 `worktree_path`;runner-host 启动 runner 前 assert
4. `fs-browse` **必须**在 user 显式指定 host 的范围内,且只允许列目录(不暴露文件内容)

---

## 八、Codex Adapter

`packages/runner-host/src/adapters/codex/index.ts` 实现 `RunnerAdapter` (SP-1 contract):

```ts
class CodexAdapter implements RunnerAdapter {
  readonly id = "codex";
  readonly capabilities: RunnerCapability[] = [
    "streaming",
    "tool-events",
    // 不声明 "session-resume" — Codex CLI 续轮机制(stdin JSON-RPC)跟 Claude Code 的 `--resume <id>` 不一样;
    // SP-3+1 想办法对齐,SP-3 留差异:Codex task retry = 重起进程,Claude Code task retry = 续 session
    // 不声明 "permission-prompt" — sandbox 已放开
  ];

  async startSession(opts: SessionStartOpts): Promise<RunnerSessionHandle> {
    return spawnCodex({
      cwd: opts.workspacePath,
      sandbox: "danger-full-access",
      systemPrompt: opts.systemPrompt,
      initialMessage: opts.initialMessage,
    });
  }

  async resumeSession(): Promise<never> {
    throw new Error("codex adapter does not support resume");
  }
}
```

### 为什么 Codex resume 不做

Symphony 调研显示 Codex **能** sticky 续轮(stdin JSON-RPC 串起来),但需要 Symphony 那种 elixir 进程模型 / sticky 子进程管理。SP-3 走更简单路径:每次 retry = 起新 Codex 进程,接受 cold-start 成本。SP-3+1 想做时,可以在 `runner-host` 加 process pool。

**Adapter 抽象被压测的核心证据**:看板上"Retry" 按钮对两种 adapter 的实际行为通过 `capabilities` 自动分支 — `session-resume` 声明的(Claude Code)走快路径,没声明的(Codex)走 cold-start 路径。这就是 SP-1 capability 抽象的真验证。

---

## 九、UI 接线变化

### Desktop (`apps/desktop/src/Shell.tsx`)

当前 PR #11 落地后:
- `page` state 已扩展 `chat | settings | projects | project | project-settings`
- 各 modal 的 onCreate/onAction 是 `console.log`

SP-3 实施时(Track E 主权):
- 接 `useProjects()` 替换 `MOCK_PROJECTS`
- 接 `useProjectTasks(projectId)` 替换 `MOCK_TASKS.filter(...)`
- 接 `useTaskDetail(taskId)` 给抽屉用
- onCreate → `api.createProject(...)` / `api.createTask(...)`
- onAction → `api.taskAction(taskId, {action: ...})`

### Web (`apps/web/src/App.tsx`)

当前已有 `mode='project'` toggle 但主区空(dead UI)。SP-3 加:
- 镜像 desktop 的 page state
- 从 `@cogni/ui` import 同样组件(组件提升后)
- NewProject modal 在 web 端**加一个 Step 0**:先选 host → 然后 repoPath 字段旁边出现"📁 浏览该 host" 按钮,点击调 `useHostFsBrowse(hostId)` 返回目录树,选完填 repoPath

### Sidebar (`packages/ui/src/components/Sidebar.tsx`)

PR #11 已经把 sidebar 改成 mode-aware。SP-3 实施时:
- `chat` mode 数据源不变
- `project` mode 数据源 mock_projects → `useProjects()`
- needs-input badges 数据源 mock → `useProjects()` 返回值(在 `ProjectSummary` 加 `needsInputCount: number` 字段)

### 删 SP-2 留尾巴

- `packages/ui/src/components/Conversation.tsx`:删 `<PermissionPrompt>` 用法 + onAllow/onDeny callback 占位
- `packages/ui/src/components/ChatBlocks.tsx`:`<PermissionPrompt>` 整组件删
- (TaskDetail 嵌入 ChatBlocks 时不会渲染 permission-request 事件 —— 这种事件 SP-3 也不再产生)

---

## 十、实时同步链路

完全复用 SP-2 ClientHub fan-out。新增订阅通道:

```ts
// packages/contract/src/protocol.ts (client → server)
| { t: "subscribe-projects" }                    ← 订阅"我的项目列表" (sidebar/列表页用)
| { t: "subscribe-project"; projectId: string }  ← 订阅某项目的看板(task state 变化、新 task)
| { t: "subscribe-task"; taskId: string }        ← 订阅某 task 的详细事件(抽屉用)

// (server → client)
| { t: "project-list-update"; project: ProjectSummary }   ← 项目级状态变化
| { t: "task-update"; task: ProjectTask }                  ← 卡片字段变化
| { t: "task-event"; taskId: string; event: RunnerEvent }  ← runner 事件转发(抽屉嵌入 ChatBlocks 实时流)
```

`task-event` 实质等价于 SP-2 的 `event` 消息携带 `threadId=execution_thread_id`。SP-3 选择新增 `task-event` 类型让前端路由更直观,而不是混用 thread 通道。

**WsClient (SP-2 已多路复用)**:在 `subscribe-thread` 基础上加 `subscribe-projects` / `subscribe-project` / `subscribe-task`,机制一致 — 一条长连接、N 个订阅、reconnect 自动 resubscribe。

---

## 十一、用户视角:三条主链路(表现 + 行为)

### 链路 A · 新建项目并创建第一张 task

**桌面**:
1. 用户登录,Sidebar 顶部 toggle 切到「项目」 → 主区显示"还没有项目" 引导卡
2. 点 `新项目` → modal 弹出
3. 填名称 / repoPath(浏览本地文件夹) / 默认 host(下拉自动列出在线 host) / merge_policy(默认 require-review) / 并发上限(stepper 默认 2)
4. 点「创建项目」 → cloud INSERT projects + 在 default host 上 `git-init-if-missing`(如果勾选) → 立刻进项目看板(空)
5. 点 `+ 新任务` → modal 三 tab,选「手动」 → 填标题/描述 → 「创建任务」
6. 看板上立刻出现一张 `queued` 卡。**5 秒内** reconcile tick dispatch → 卡变 `running` + host chip 显示 default host 名 + 活动条开始滚动
7. runner 跑(claude-code 默认 adapter,`--dangerously-skip-permissions`),events 实时进抽屉(如果用户点开了)
8. runner 报 `done` → 项目设的 `require-review` policy → 卡变 `reviewing`,头部状态 chip 黄色,活动条变 "Awaiting review"
9. 用户点卡片 → 抽屉打开,显示 diff(host 上 `git diff main..task/...` 的结果)+ Accept/Reject 按钮
10. 点 Accept → cloud 调 `git-merge-to-main` → host 执行 `git checkout main && git merge --no-ff task/...` → 成功 → 卡变 `done`,worktree 删除
11. 看板上下一张 `queued` 卡若存在 → 自动 dispatch(因为现在 running 数 = 0 < cap=2)

**Web**:1-11 同上,但第 3 步 modal 加 Step 0:先在下拉里选 host,然后 repoPath 字段旁边"📁 浏览" 按钮点击 → host 返回目录树 modal → 用户在树里选(或继续手输)。

### 链路 B · runner 中途问业务问题(needs-input 新语义)

1. 卡片 `running` 中,活动条显示"Read src/App.tsx" → "Edit src/Todo.tsx +5 -2" → 突然变 "Asked: 你想用 React Context 还是 Redux?"
2. 同时:卡片右上角红色 badge 数字 1,卡片状态 chip 切为 `Needs input`(amber 色 pulse 边框 — PR #11 已实现)
3. Sidebar 项目卡片右上角也出现红 badge,项目名前小红点
4. 用户点开抽屉 → header 状态 stepper 在 `needs-input` 节点高亮 → 活动区显示 runner 的问题消息(由 `<ChatBlocks>` 渲染) → Composer 显示
5. 用户在 Composer 输入"Context 就行" → 发送 → cloud 收到 user message → POST 到 execution_thread → cloud lifecycle 把 task state 切回 `running`,清 `needs_input_what`
6. 抽屉里 runner 续 turn,继续 stream "OK,using Context API" → activity 条更新 → 红 badge 消失
7. 后续按链路 A 第 7 步起继续

### 链路 C · host 重启 / network blip

1. 用户笔记本合盖 30s,desktop app 进入睡眠;runner 进程在 host 上继续跑(host 是独立 daemon,**不睡眠**) → events 持续累积到 cloud(SP-2 events.seq)
2. 用户打开 desktop,WsClient 自动重连(SP-2 落地的 multiplex WS) → resubscribe 所有 active subscription
3. 看板 / 抽屉自动 catchup:`subscribe-project` 收到这段时间内 task state 变化的快照;`subscribe-task` 收到 events catchup(基于 lastSeq) → 抽屉里 ChatBlocks 顺序追上 runner 当前进度
4. 如果是 host 离线(不是 desktop):reconcile tick 检测 → task state → `queued`(等 host 回来),task_run.exit_reason='host-disconnect',retries++ → retry tick 重新 dispatch(host 回来后) → cloud 调 `git-worktree-create`(worktree 还在,host 检测 worktree 存在则跳过) + 起 runner(用 `session-resume` capability 续 session,如果 adapter 声明了)

---

## 十二、工程节奏(5 track fanout)

| Track | 主权 | 验收 |
|---|---|---|
| **A · Contract + DB** | `packages/contract/src/{protocol,host-protocol,types/project}.ts`<br>`packages/cloud/src/db/schema.ts` + drizzle migration | typecheck 全绿;new types exported;migration up-down 通 |
| **B · Cloud project domain** | `packages/cloud/src/domains/project/**`<br>`packages/cloud/src/server.ts` 挂载新 domain | unit test:lifecycle 状态转换 8 条 + reconcile 三种分支 + mergeGate 三种 policy + ref-allocator 并发 |
| **C · Cloud HTTP routes** | `packages/cloud/src/routes/projects.ts` | integration test:所有 routes happy path + 越权 404/403 + 状态非法操作 400 |
| **D · Host RPC + Codex adapter** | `packages/contract/src/host-protocol.ts` 新消息<br>`packages/runner-host/src/{git-ops, fs-browse, adapters/codex}/` | unit test: git-ops 各 RPC happy path + 主仓库越界拒绝 + Codex adapter capability 协商 + spawnCodex mock |
| **E · UI 接线** | `packages/ui/src/{components/project, hooks/useProject*, transport/api}.ts`<br>`apps/desktop/src/Shell.tsx`<br>`apps/web/src/App.tsx` | dev verify:桌面创建项目 → 创建 task → 看 reviewing → Accept;Web 同流程 + Step-0 选 host 浏览 fs |

**依赖序**:
1. **Track A 单独 land**(其他 4 个 track 全部 import A 的 types)
2. **B / C / D / E 并行**(B 的 lifecycle 接口 + C 的 routes contract 在 A 落地后已经清楚;UI 用 mock client 先开发,真 API 上线后接线)

**估算**:工作量大致跟 SP-2 同量级(SP-2 是 ~5 track 的 fanout)。前端 mock-driven 那部分(PR #11)**已经 land 不重复**,SP-3 主要是 backend + 接线。

---

## 十三、不在范围 + 推到后续

| 不做 | 推到 | 原因 |
|---|---|---|
| Permission middleware / Allow/Deny UI | 永不(设计选择信任 sandbox) | sandbox + worktree 物理隔离 + reviewing 人审已经覆盖大多数风险 |
| `cogni__create_task` runner tool + Workspace Chat 面板 | SP-4 | 前端没画,backend 不做。需要 brainstorm UI 形态 |
| Linear OAuth / GraphQL / poll loop | SP-3+1 单独 epic | 前端 source 字段 backend 不存,Linear UI 是占位符 |
| Per-task host override | SP-3+1 | 前端 NewTask 没暴露 host picker;UI + backend 一起加 |
| 多节点 cogni-cloud + leader 选举 | SP-3+1 | reconcile 是单进程 setInterval,SP-3+1 改 Redis-locked leader-only tick |
| 跨 host fan-out / task migration | SP-4 | Symphony 也不支持;cogni multi-host 当前是"分散 worker 池",每 task sticky |
| 第三种 adapter | SP-4 | 两个足够压测抽象 |
| Web 端 host-fs-browse 安全 hardening(符号链接逃逸 / 隐藏文件) | SP-3+1 ops | MVP 只暴露目录列表,host 端做基本路径校验,不深做 |
