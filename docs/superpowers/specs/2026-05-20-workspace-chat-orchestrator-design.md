# Workspace Chat 运行编排浮窗 — 设计文档

> SP-4 业务功能。延续 SP-3 设计文档第十三节预留的
> 「`cogni__create_task` runner tool + Workspace Chat 面板」。
> 把 cogni 从「点按钮管看板」扩展为「跟 AI 说一句话就帮你编排项目和任务」。

## 一、目标与范围

在 `我的项目` 列表页与单个项目 board 内,提供一个常驻底部输入条 →
点击展开成圆角浮窗的对话界面。用户在浮窗里跟 Cogni 自然语言对话,Cogni
根据对话**立即执行**对项目/任务的增删改——**人在这个界面能做的,聊天里的
AI 都能做**。

### 能力全集(= 人能做的操作)

| 类别 | 工具 | 后端 |
| --- | --- | --- |
| 只读上下文 | `list_projects` / `list_tasks` | 现有 GET 路由 |
| 任务 | `create_task` / `cancel_task` / `delete_task` / `accept` / `reject` / `retry` / `reply` | create/cancel/accept/reject/retry/reply 现有;**`delete_task` 净新增** |
| 项目 | `create_project` / `rename_project` / `delete_project` | create(POST)/rename(PATCH)现有;**`delete_project` 净新增(硬删除级联)** |

### 关键决策(已与用户确认)

- **两个入口都要**:列表页工作区级(跨项目)+ 项目 board 内项目级(绑定当前项目)。
- **全部立即执行**:包括删除/取消,无二次确认。浮窗事后说明做了什么。
- **删除项目 = 硬删除级联**:连同其下任务 + worktree/session 记录一并删除。MVP
  不做撤销窗口(与「立即执行」语义一致)。
- **执行架构 = runner-based**:编排由 host 上的 Claude Code runner 完成(不是云端
  agentic loop)。后果:**无 host 在线时浮窗禁用**。

### 不在范围

- 撤销/回滚窗口、删除前二次确认弹窗。
- 跨 user / 跨 workspace 编排。
- 第二种 orchestrator adapter(codex 编排)——先只做 Claude Code。
- 主动干预(Cogni 未经对话自行改看板)。

## 二、用户体验(web + desktop 共用 `@cogni/ui`)

两端同一套组件,行为一致。

### 表现

- **收起态**:页面底部常驻一条圆角输入条。placeholder:
  - 列表页:「让 Cogni 帮你建任务、关任务、整理项目…」
  - 项目内:「在『<项目名>』里…」
- **展开态**:点击 / 聚焦输入条 → 向上「长」出圆角浮窗(底部锚定,消息区在上方,
  最大高度约 60vh,内部滚动)。消息区复用 `<ChatBlocks>` 渲染;底部是输入框。
- **收起**:点浮窗外、按 `Esc`、或点收起按钮 → 浮窗收回成输入条,**对话历史保留**
  (下次展开接着看)。
- **异常态**:无 host 在线 → 输入条禁用 + 文案「需要本地 Cogni 在线才能编排」。
  看板/列表数据照常加载(那是云端数据,与 host 在线无关)。
- **空态**:首次展开显示一句引导 + 几个示例 chip(「建个任务」「把失败的重试」)。

### 行为时序(例:列表页输入「给贪吃蛇加个排行榜任务」)

1. 用户消息气泡入列 → Cogni「思考中」流式文字(runner 实时输出,复用
   `useThreadStream`)。
2. Cogni 调 `cogni__create_task(project="贪吃蛇游戏", title="加排行榜")` → 看板/
   列表**实时变化**:贪吃蛇项目卡「排队」数字 +1;若用户正在该项目 board 内,新
   任务卡**淡入**(由 ClientHub `task-create` 广播驱动,与人手动建任务同一路径)。
3. 浮窗回:「已在『贪吃蛇游戏』建任务 `SNK-3 加排行榜`,已下发 runner」。

### 立即执行(无确认)的表现

- 「把那个失败的删了」→ 对应任务卡**淡出消失**(`task-delete` 广播)→ 浮窗说明
  删了哪个任务。
- 取消、accept/reject、retry、reply 同理:动作即时落库 + 广播,浮窗事后总结。

### 两个入口的差异

| | 列表页(工作区级) | 项目 board 内(项目级) |
| --- | --- | --- |
| Thread | 每 user 一个 workspace thread(`project_id=NULL`) | 复用 `projects.thread_id` |
| 指代项目 | 用项目名,AI 不明确时追问 | 已绑定当前项目,无需报名 |
| 可做 | 全集(含建/删项目) | 该项目内任务全集 + 改本项目 |
| host | user 默认 / 任一在线 host | `project.default_host_id` |

## 三、执行架构(runner-based)

```
浮窗输入 ─clientToCloud─▶ WorkspaceChatDomain(云,新增)
                              │ dispatch 到 orchestrator runner session(task_id=NULL,--resume)
                              ▼
                         host 上的 Claude Code runner
                         (--mcp-config 挂载 cogni MCP server,--allowedTools 限定 cogni__*)
                              │ 调 cogni__create_task / cogni__delete_task ...
                              ▼
                         cogni MCP server(runner-host 内本地 stdio MCP)
                              │ 读 ~/.cogni/host.json 拿 cloudUrl + hostToken
                              │ REST 调云端现有路由,Authorization: Host <token>
                              ▼
                         云 ProjectDomain.createTask / deleteTask ...
                              │                              │
                         结果 JSON 回 MCP → 回 runner    ClientHub 广播 task/project 变化
                              │                              ▼
                         runner 流式文字 ─▶ 云 ─▶ 浮窗     看板/列表实时更新(已有路径)
```

### 组件职责

- **`WorkspaceChatDomain`**(`packages/cloud/src/domains/workspace-chat.ts`,仿
  `ChatDomain`):
  - `handleClientSend`:把浮窗消息持久化到对应 thread,dispatch 给该 thread 的
    **常驻 orchestrator runner session**(`task_id=NULL`)。session 用
    `--resume` 维持对话连续。
  - `handleHostEvent`:把 runner 流式 text / tool-call / tool-result 转发给
    ClientHub(浮窗 `<ChatBlocks>` 实时渲染)。
  - host 选择:工作区级取 user 默认/任一在线 host;项目级取
    `project.default_host_id`。无在线 host → 返回禁用信号,浮窗进入异常态。
  - orchestrator cwd:中性目录 `~/.cogni/workspace`(它只调 MCP 工具,不碰文件)。
- **cogni MCP server**(`packages/runner-host/src/mcp/cogni-tools.ts`,本地 stdio
  MCP):
  - 暴露 `cogni__*` 工具(见第一节表)。工具实现 = 读 `~/.cogni/host.json` →
    `fetch` 云端 REST,带 `Authorization: Host <token>`。
  - 由 Claude Code adapter 通过 `--mcp-config <生成的临时 json>` 挂载,
    `--allowedTools` 限定只允许 `cogni__*`(orchestrator 不应碰文件系统工具)。
- **云端 host-auth 中间件**(`packages/cloud/src/routes/projects.ts` 复用):
  - 现有 project/task 路由接受 `Authorization: Host <hostToken>`,解析 host →
    其所属 user → 以该 user 身份执行。复用全部现有路由逻辑。
- **Claude Code adapter** 改动(`adapters/claude-code.ts`):`StartSessionOpts`
  增加可选 `mcpConfigPath` + `allowedTools`,spawn 时追加 `--mcp-config` /
  `--allowed-tools`。普通 chat / task session 不传 → 行为不变。

### 为什么是 REST + host-auth(而非新造 host→cloud WS RPC)

- MCP server 是 claude 启动的独立 stdio 进程,不持有 daemon 的云 WS 连接。
- 直接复用现有 REST 路由 = 零新增协议面,只加一层 host-auth 解析。
- host token 已在 `~/.cogni/host.json`(SP-1 注册时写入),云端已有 host→user 映射。

## 四、数据模型

- **threads**:新增 `kind` 列(`'chat' | 'workspace'`,默认 `'chat'` 保持现有
  行为不变)。
  - 工作区级:每 user 一个 `kind='workspace'` thread,`project_id=NULL`。
  - 项目级:复用 SP-3 已预留的 `projects.thread_id`(SP-3 注释:留给 SP-4
    Workspace Chat),保持 `kind='chat'`。
- **messages**:用户消息 + runner 输出落此表,浮窗 `<ChatBlocks>` 直接读。
- **runner_sessions**:orchestrator session 行 `task_id=NULL`(与 SP-1/SP-2 chat
  session 同类),`thread_id` 指向上面的 workspace/project thread。

### 净新增后端

- `ProjectDomain.deleteTask(taskId)`:若任务在 running → 先 `cancelTask` 停 runner
  → 删 `project_tasks` 行(级联 `runner_sessions.task_id` SET NULL)→ 广播
  `task-delete`。
- `ProjectDomain.deleteProject(projectId)`:级联删该项目所有 `project_tasks`(逐个
  走 deleteTask 的 cancel-then-delete)+ 项目行 + thread → 广播 `project-delete`。
- 路由:`DELETE /api/tasks/:taskId`、`DELETE /api/projects/:id`。
- ClientHub 协议(`cloudToClient`)新增:`task-delete { taskId }`、
  `project-delete { projectId }`(列表/看板据此移除卡片)。

## 五、UI 组件

- `packages/ui/src/components/project/WorkspaceChatBar.tsx`(+css):底部输入条 +
  展开浮窗容器。收起/展开状态、host 在线禁用态、空态引导。
- 复用:`<ChatBlocks>` 渲染消息流、`useThreadStream` 订阅。
- 接线:`ProjectsList`(列表页,workspace thread)与 `ProjectBoard`(项目内,
  `project.thread_id`)各挂一个,传入对应 thread + 绑定 scope。
- 列表/看板订阅新增处理 `task-delete` / `project-delete`(移除卡片,带淡出)。

## 六、错误处理与边界

- **host 离线**:浮窗禁用态;若发送中 host 掉线,复用 ChatDomain 的 fallback 提示
  模式。
- **指代不明**(列表页「把那个任务删了」):`list_tasks` 返回候选 → AI 在对话里
  追问澄清,不瞎删。
- **删 terminal 任务 / 不存在的 id**:工具返回结构化错误,AI 转述给用户。
- **删除跑着的任务**:deleteTask 内部先 cancel runner 再删,避免孤儿 runner。
- **host-auth 越权**:host token 只能操作其所属 user 的资源;跨 user 请求 403。
- **并发**:人手动操作与 AI 操作走同一 ProjectDomain + 广播,天然一致(乐观 UI 由
  广播纠正)。

## 七、测试

- pglite 单测(`packages/cloud`):
  - `deleteTask`:running → 先 cancel 再删;terminal → 直接删;级联 session SET NULL。
  - `deleteProject`:级联删任务 + thread;广播 `project-delete`。
  - host-auth 中间件:host token → user 解析;跨 user 403。
  - `WorkspaceChatDomain.handleClientSend`:dispatch 到 orchestrator session;无在线
    host → 禁用信号。
- MCP 工具层(`packages/runner-host`):工具 → REST 契约测试(mock cloud fetch),
  覆盖鉴权头 + 错误转述。
- adapter:`mcpConfigPath` / `allowedTools` 传入时 spawn args 含 `--mcp-config` /
  `--allowed-tools`;不传时 args 不变(回归)。

## 八、实现顺序建议

1. 后端净新增:`deleteTask` / `deleteProject` + DELETE 路由 + 广播协议 + host-auth
   中间件(可独立测,先落)。
2. cogni MCP server + adapter 的 `--mcp-config` 支持。
3. `WorkspaceChatDomain` + dispatch/事件转发 + thread 模型。
4. UI:`WorkspaceChatBar` + 两处接线 + 列表/看板删除卡片处理。
5. 端到端:列表页与项目内各跑一遍「建 / 删 / 取消 / 审核」对话。
