# Cogni — SP-1「脊梁」设计文档

> 日期:2026-05-14
> 状态:已通过头脑风暴评审,待评审 spec 后进入实现计划

---

## 一、背景

把两个个人「做事助手」demo 合并为一个正式产品 **Cogni**:

- **`~/code/ai-cognit`** — toC 通用助手。TS/Bun。`contract/v1` 把 agent 内核(claude2,Claude Code 定制分支)与外层解耦;backend 有 identity / memory / dispatcher / events / skill-registry;多 channel(飞书/webchat/mac-app/ios);理念是「大脑在云、手在本地」。
- **`~/code/cognit-flow`** — AI worker 编排器。TS/Node。轮询 Linear → 每 issue 一个独立 workspace → 拉起 coding agent(Codex CLI / Claude Code CLI,adapter 可换)→ 监督到 issue 离开活跃态,有界重试 → Hono+SSE 看板;有 control-plane 多项目模式。

两者共性:都由一个 **agent runner 内核**驱动,都配一套**账户系统**,差别只在外层的「组织模式 + 交互模式」(chat 对话 vs 项目看板)。

目标:抽出两者理念,重新实现一个稳健、专业的新产品。

### 用户偏好(硬约束)

- 开发语言 TypeScript
- 数据库 Neon
- 多端数据要能同步
- agent runner 与外层架构解耦(后续支持各开源/闭源 runner,如 Codex)
- 后续同时支持 mac/win 桌面;web/app 是阉割版瘦客户端,缺本地 runner 环境,需配对电脑的运行态,实际运行仍在电脑上
- 前端 UI 参考 Claude 桌面 app:左栏顶部 chat/项目模式切换,侧边栏 New chat / Projects / Artifacts / Customize / Recents,主区在「chat 对话页」和「看板页」之间切换

---

## 二、四根支柱(已确认的架构决策)

| # | 决策点 | 选定 |
|---|---|---|
| 1 | 用户模型 | **多用户对外产品** — 完整 auth/OAuth/多租户、数据隔离、未来可计费 |
| 2 | 核心模型 | **共享内核 + 两个独立域** — runner 抽象/账户/Neon/同步是共享内核;chat 域和项目域各有自己的数据模型和编排器,跑在内核之上;Recents/artifacts/记忆需要一个显式跨域层 |
| 3 | Runner 抽象 | **进程隔离 adapter + 能力协商** — 每个 runner 是外部进程,藏在统一 adapter 接口后;接口定义能力全集,各 adapter 声明自己支持哪些,外层按能力优雅降级 |
| 4 | 多端拓扑 | **云控制面 + 桌面 runner host** — 云端拥有账户/数据(Neon)/域逻辑/编排决策;桌面 app = UI 客户端 + 注册一个本地 runner host;web/app 瘦客户端只连云端,云端把需要本地的活路由给用户在线的桌面 host |

### 目标架构

```
                  ┌──────────── 云控制面 (Cloud Control Plane) ────────────┐
   web/app  ─────▶│  账户/身份 (auth, OAuth, 多租户)                        │
   瘦客户端        │  Neon (唯一真相源) + 响应式同步                          │
                  │  ┌──────────┐  ┌──────────┐   ← 两个独立域              │
                  │  │ chat 域  │  │ 项目域   │                            │
                  │  └──────────┘  └──────────┘                            │
                  │  跨域层: Recents / artifacts / 记忆                      │
                  │  Host Router: 把 runner 活儿路由给在线的桌面 host        │
                  └───────────────────────┬─────────────────────────────────┘
                                          │ host 协议 (常连)
                       ┌──────────────────┴──────────────────┐
                ┌──────▼──────┐                      ┌────────▼────────┐
                │ 桌面 app(mac)│                      │ 桌面 app(win)   │
                │  UI 壳       │                      │  UI 壳          │
                │  + Runner Host                      │  + Runner Host  │
                │    └ adapter: claude / codex / ...   │                 │
                └─────────────┘                      └─────────────────┘
```

- **云控制面**:无状态应用层 + Neon。拥有账户、数据、两个域、跨域层、Host Router。
- **Runner 抽象**:统一 adapter 接口(能力协商),作为 contract/库存在,每个 runner 一个 adapter。
- **Runner Host**:独立常驻 daemon,内嵌随桌面 app 分发,向云端注册并广播自己有哪些 adapter/能力,负责跑 runner 进程、回流事件。
- **桌面 app** = UI 壳(参考截图) + 管理本地 Runner Host daemon。**瘦客户端** = 只有 UI 壳,只连云端。

---

## 三、子项目拆分

整个产品太大,无法一个 spec 覆盖。拆成 4 个子项目,各自走一遍 spec → plan → 实现。构建顺序:**脉络优先,SP-1 → 2 → 3 → 4**。

| 子项目 | 内容 | 跑通后的样子 |
|---|---|---|
| **SP-1 脊梁**(本文) | 云控制面骨架 + Neon + 最小 auth;Runner 抽象 contract + Claude Code adapter;Runner Host daemon;host 协议;桌面 app 最小壳;chat 域最小闭环 | 桌面登录 → chat 里说话 → 云端路由到本地 Runner Host → Claude Code 跑 → 流式回来。四根支柱被一刀穿透 |
| **SP-2 账户 + 多端同步 + 瘦客户端** | 完整 auth/OAuth/多租户、设备&host 管理 UI;响应式同步层;多 host 路由 + "哪台在线"交互;web 瘦客户端 | 多设备登录同账号、数据实时同步;web 端能用(配对到桌面 host) |
| **SP-3 项目域** | 监督式编排器(cognit-flow 理念:每任务独立 workspace、监督循环、有界重试);看板视图;tracker 集成;Codex adapter(第二个 runner,验证抽象) | 项目模式可用,一批任务能自主跑起来 |
| **SP-4 跨域层 + 完整化** | 跨域 Recents/artifacts/记忆(user world model);Customize、昼夜模式、全局快捷键、菜单栏;Windows 打磨、事件订阅/主动介入 | 产品完整体 |

**为什么这么拆**:SP-1 是穿透所有支柱的最小闭环,一次性验证四个最难的集成点(账户、数据、runner 抽象、云↔桌面拓扑);之后 SP-2/3/4 在已验证的脊梁上长肉,每个都能独立交付。

---

## 四、SP-1 详细设计

### 第 1 节 · 工程结构

新仓库 = `~/code/cogni`。Monorepo(pnpm workspaces,Node):

```
cogni/
├── packages/
│   ├── contract/        ← runner 抽象接口 + host 协议类型 + 域共享类型(唯一耦合面)
│   ├── cloud/           ← 云控制面(Hono,软选型)
│   │   ├── auth/        ← Google OAuth + session
│   │   ├── db/          ← Neon schema + 查询(drizzle,软选型)
│   │   ├── host-router/ ← 跟 Runner Host 的常连 + 路由
│   │   ├── domains/chat/← chat 域编排器
│   │   └── api/         ← 给客户端的 HTTP/WS API
│   ├── runner-host/     ← 独立常驻 daemon
│   │   ├── registry.ts  ← 向云端注册 + 心跳
│   │   ├── adapters/claude-code/  ← 第一个 runner adapter
│   │   └── runner-manager.ts      ← runner 进程生命周期
│   └── shared/          ← 日志/配置/工具
└── apps/
    └── desktop/         ← Tauri app(软选型),纯 UI 壳;装好后确保 runner-host daemon 在跑
```

桌面 app 和 runner-host 是**两个独立进程**:桌面 app 负责安装 daemon、登录自启注册、显示其状态;daemon 自己常驻。

**软选型**(实现时可推翻):Tauri(桌面) / Hono(云端 HTTP) / drizzle(Neon ORM)。

### 第 2 节 · 数据模型(Neon,SP-1 最小集)

```
tenants         (id, name)                          ← 多租户根,SP-1 就一个
users           (id, tenant_id, email, oauth_sub)
hosts           (id, tenant_id, user_id, name, status, capabilities_json, last_seen)
threads         (id, tenant_id, user_id, title, created_at, updated_at)   ← 一条 chat
messages        (id, thread_id, role, content, created_at)
runner_sessions (id, thread_id, host_id, adapter, runner_session_id, status)
                                  ← thread↔runner 会话绑定;runner_session_id 用于 resume
events          (id, thread_id, session_id, seq, type, payload_json, created_at)
                                  ← runner 回流的流式事件,既是真相源也是回放/同步基础
```

Neon 是唯一真相源。`events` 表是关键设计:runner 回流的一切先落 events 再 fan-out —— SP-2 的多端同步本质就是「订阅 events」。

### 第 3 节 · Runner 抽象 contract

```ts
interface RunnerAdapter {
  readonly id: string;                       // "claude-code"
  readonly capabilities: RunnerCapability[]; // 声明支持哪些能力
  startSession(opts): Promise<RunnerSessionHandle>;
  resumeSession(runnerSessionId, opts): Promise<RunnerSessionHandle>;
  // handle: send(msg) -> AsyncIterable<RunnerEvent>; close()
}

type RunnerCapability =
  | "streaming" | "session-resume" | "tool-events"
  | "permission-prompt" | "memory-injection" | "active-injection" | "attachments";

type RunnerEvent =
  | { type: "text-delta", text: string }
  | { type: "tool-call", name: string, input: unknown }
  | { type: "tool-result", ... }
  | { type: "permission-request", ... }
  | { type: "session-id", id: string }   // runner 自己的 session id
  | { type: "done", ... }
  | { type: "error", ... };
```

接口定义**能力全集**。SP-1 的 Claude Code adapter 只落地 `streaming + session-resume + tool-events`,其余 capability 留在接口里但不声明、不实现(SP-3/SP-4 再补)。

Claude Code adapter = 子进程跑 `claude --print --output-format stream-json --resume <id>`,把 stream-json 输出翻译成 `RunnerEvent`,记住 runner 返回的 session id 用于下一轮 resume。

### 第 4 节 · Host 协议(云 ↔ Runner Host)

- Runner Host 主动向云端拨 **WebSocket**(NAT 后面只能 host dial out),用注册 token 鉴权。
- 建连 → host 上报 `register { hostId, capabilities = 所有 adapter 能力并集, version }` → 定期心跳。
- 云端下发 `dispatch { sessionId, threadId, adapter, runnerSessionId?, message }`。
- host 回流 `event { sessionId, seq, runnerEvent }` 流,结束发 `session-update { status }`。
- 断连:云端标记 host offline;host 重连后靠 runnerSessionId resume 未完成会话。

### 第 5 节 · Chat 域闭环(端到端 — 表现 + 行为)

**用户看到的**:桌面 app 左栏顶部是 chat/项目模式切换(SP-1 项目 tab 灰置),左栏 Recents 列历史 thread,中间是当前对话,底部输入框。

**行为时序**:
1. 输入框打字回车 → 桌面 app 经 WS 把消息发给云端
2. 云端 chat 域:消息落 `messages` → 找/建 thread 的 `runner_session` → Host Router 找用户在线的 host
3. **无在线 host** → 立刻回一个状态:对话页顶部提示「本地运行环境未连接」,消息排队
4. 有 host → 云端下发 `dispatch`
5. host 的 Claude Code adapter 跑起来,`RunnerEvent` 流式回流云端
6. 云端每个 event 落 `events`(带 seq)+ 实时 fan-out 给连着这个 thread 的客户端
7. 桌面 app:`text-delta` 逐字渲染、`tool-call` 显示工具块、`done` 定稿
8. 助手最终消息落 `messages`

**异常态**:
- host 中途断连 → 重连后靠 `events.seq` 回放,不丢
- runner 报错 → 对话里渲染 error 块
- 无在线 host → 顶部提示,输入框可打字,发送后排队

### 第 6 节 · SP-1 明确不做(YAGNI)

- 多 OAuth provider、注册/邀请流程 → SP-2
- 多端实时同步、web 瘦客户端 → SP-2
- 项目域、看板、tracker、Codex adapter → SP-3
- 跨域 Recents/artifacts/记忆、主动介入 → SP-4
- 权限委托、dispatcher 重写执行端、记忆注入 → contract 留接口,SP-1 不实现
- Windows 端 → SP-1 先 mac

---

## 五、SP-1 验收标准

单用户、单 host、单设备的端到端闭环:

桌面 Google 登录 → 新建 chat → 发消息 → 云端路由到本地 Runner Host → Claude Code 跑起来(工具调用 + 文本)流式回到桌面 app → thread 和消息持久化在 Neon → 关掉 app 重开,Recents 里还在、能继续这个 thread。

---

## 六、待后续子项目澄清的开放项

- 项目域的 backlog 来源:Linear(外部) / 内部 tracker / 两者都要 —— SP-3 头脑风暴时定
- 桌面是否需要离线工作能力(local-first 后补同步) —— 当前假设「在线优先,runner host 容忍短暂断连」,SP-2 时确认
- 计费模型 —— 远期,不影响 SP-1~SP-3 架构
