# Cogni · SP-3「项目」模块 — 前端设计需求

发给你做下一批 design handoff 用。沿用上次给我的 `handoff/` 包结构和约定（BEM-ish 类名、TypeScript inline 类型、每个组件一个 `.css`、中文 UI、tokens.css 取色），目录命名 `handoff-sp3/`。

---

## 1. 背景

**Cogni** 是个 AI 助手产品，已经做完：

- **SP-1** 脊梁：桌面 app（Tauri + React）+ 云控制面 + runner-host daemon + chat 域端到端流式
- **SP-2** 账户 / 多端同步 / 多 host / 瘦客户端（进行中）
- **SP-3** 项目域（本次）：从"对话助手"扩展为"监督式 AI worker 编排器"。每个项目下有一组任务，跑在 runner host 上，状态机 queued → running → needs-input → reviewing → done/failed。任务来源不固定（Linear / 内部 tracker / 手动）

设计语言、tokens、字体、图标、原子组件（`.btn` / `.pill` / `.dot` / `.seg` / `.kbd` / Icon.* / ChatBlocks）请**完全复用**上一批 handoff，不要新建。

上一批 handoff 已经给过一个 `Project.tsx`（columns / swarm / timeline 三视图，用 MOCK_TASKS），作为项目详情看板的 reference。这次要把"项目"这一整套体验补完整。

---

## 2. 要覆盖的视图

### A. 项目列表（Projects index）
Sidebar 切到「项目」模式后主区第一屏。

- 顶部：`新项目` 按钮 + 搜索框 + 排序/筛选
- 卡片网格：项目名、描述截断、`N 个 runner 在跑 · M 个排队`、最近活动时间、健康状态点（绿/黄/红）
- 空态：没有项目时的引导卡（"创建第一个项目"）
- 卡片右上：项目级状态徽（健康 / 有失败 / 暂停）

### B. 项目详情（监督看板）
上一批的 `Project.tsx` 是基础，请保留 columns / swarm / timeline 三视图风格，但补：

- 顶部 breadcrumb：`项目列表 / <项目名>`
- 顶部 toolbar：视图切换 seg、`新任务` 按钮、项目设置入口
- swarm 视图的 Pod 卡片增加：点击后打开**任务详情抽屉**
- needs-input 状态高亮（看板视图也要明显能看出"有几个任务在等人"）

### C. 任务详情
你拿主意是抽屉、模态还是子路由（我倾向**右侧抽屉**：保持看板可见、可上下切相邻任务、与 chat 的 thread 详情形态一致）。

- Header：外部 ref（COG-118）+ 标题 + 状态徽 + host 名
- 状态时间线：queued → running → needs-input → reviewing → done（横向 stepper）
- 当前 activity 区：实时显示 agent 在做什么 + 进度条 + 重试次数 + diff 摘要（+N −M）
- 关联 thread：**完整 chat 形态嵌入**，复用 `<ChatBlocks />`（UserMessage / AssistantText / ToolCallBlock），展示监督员跑这个任务的全过程
- 操作区（按状态显示不同动作）：批准 / 拒绝 / 重启 / 升级到人工 / 看 PR / 关闭抽屉
- needs-input 时 highlight 当前需要决策的点

### D. 新建项目流程
入口：项目列表的 `新项目` 按钮。模态或单独页都可以。

- 字段：项目名、描述（可空）、Backlog 来源、Initial system prompt / context、默认 host、并发上限
- Backlog 来源 segment：`Linear` / `内部 tracker` / `手动` —— 选 Linear 时显示 teamId 输入 + 测试连接按钮（placeholder 即可，按钮点击不接真实 API）
- 提交后进入项目详情

### E. 新建任务
入口：项目详情的 `新任务` 按钮。

三种来源 tab：
1. **手动**：标题 + 描述
2. **从 Linear 拉**：team / project picker + issue 多选（mock 数据即可）
3. **上传 backlog 文件**：拖拽区，接收 .md / .csv / .txt（UI 即可，不接处理）

### F. 项目设置
项目名、描述、Backlog 来源切换、默认 host、并发上限、`删除项目`（红色，confirm 二次确认）。

### G. 空态 / 加载态 / 错误态
- 项目列表 0 个项目
- 项目详情 0 个任务
- 所有 host offline 时的 "没有 runner 能跑任务" 提示（复用现有 NoHostBanner 风格）
- tracker 接入失败提示

### H. Sidebar 的「项目」模式 适配
现在 Sidebar 顶部已有 `Chat ↔ 项目` 模式 pill 切换器，请补：

- 切到项目模式时 sidebar 中间的 Recents / Pinned 列表改成显示**项目列表**（最近活跃的项目在上、pinned 的在 Pinned 区）
- `新对话` 按钮变成 `新项目`
- 搜索框 placeholder 变 `搜索项目`
- 底部 HOSTS 状态条不变

---

## 3. 数据契约（前端 props 形状，backend 后跟）

```ts
type ProjectId = string;
type TaskId = string;
type TaskState = "queued" | "running" | "needs-input" | "reviewing" | "done" | "failed";

interface ProjectSummary {
  id: ProjectId;
  name: string;
  description?: string;
  createdAt: string;     // ISO
  updatedAt: string;
  liveRunners: number;
  queuedCount: number;
  health: "ok" | "warn" | "error";
  pinned?: boolean;
  source?:
    | { kind: "linear"; teamId: string }
    | { kind: "internal" }
    | { kind: "manual" };
}

interface ProjectTask {
  id: TaskId;
  ref: string;           // "COG-118" or "T-101"
  projectId: ProjectId;
  title: string;
  description?: string;
  state: TaskState;
  hostId: string | null;
  hostName?: string;
  startedAt?: string;
  elapsed: string;       // 已经格式化好的 "4m 12s"
  progress: number;      // 0..1
  retries: number;
  activity: string;      // 当前一句话状态
  delta?: string;        // "+87 −34"
  threadId?: string;     // 关联 thread，打开任务详情时复用 ChatBlocks 渲染
  needsInput?: { what: string };   // needs-input 时填
}

interface ProjectSettings {
  id: ProjectId;
  name: string;
  description?: string;
  source: ProjectSummary["source"];
  defaultHostId?: string;
  concurrencyLimit: number;
  systemPrompt?: string;
}
```

`MOCK_TASKS` 上一批已经在 `mock.ts` 里，可继续扩展（加 `MOCK_PROJECTS` / mock task threads / 几个 needs-input 案例）。

---

## 4. 不要做

- 不要重写已有 ChatBlocks / Markdown / Conversation 渲染——任务详情里的 embedded chat 直接 import 复用
- 不要碰 SP-1/SP-2 的 chat / settings / login
- 不要绑死任何具体 tracker —— Linear 只是个 placeholder，UI 不要假设字段
- 不要做 SP-4 的跨项目 artifacts 聚合（那是下一阶段）
- 不要加新依赖，除非和我商量

---

## 5. 交付格式（跟上次一致）

`handoff-sp3/` zip，内含：

```
handoff-sp3/
├── README.md                              ← 文件清单 + install 步骤 + 已知 trade-off
└── src/
    ├── ProjectsList.tsx + projects-list.css
    ├── Project.tsx + project.css          ← 替换现有
    ├── TaskDetail.tsx + task-detail.css   ← 抽屉/模态/页你选
    ├── NewProject.tsx + new-project.css
    ├── NewTask.tsx + new-task.css
    ├── ProjectSettings.tsx + project-settings.css
    ├── Sidebar.tsx + sidebar.css          ← 替换：增加项目模式下的列表 / 新项目按钮等
    ├── mock.ts                            ← 扩展：MOCK_PROJECTS、更多 task 状态、几个 needs-input 案例
    └── (任何新增的 atoms / cards / chips — 单文件，必要时)
```

约定（同上一批）：
- TypeScript inline 类型字面量
- 每组件一个 `.css`，组件里 `import "./foo.css"`
- BEM-ish 类名（`.foo` / `.foo__bar` / `.foo--variant`）
- 类型从 `@cogni/ui` / `@cogni/contract` 拿（contract 里现在还没有 Project 类型，自定义即可，我后面会接进 contract）
- 中文 UI copy
- 颜色全部 `var(--token)`，不要硬编码

---

## 6. 三个开放问题（请你出方案）

1. **任务详情用抽屉 / 模态 / 子路由？** 我倾向右侧抽屉，理由：保持看板可见、键盘 J/K 切相邻任务、跟 thread 详情形态一致。你可以推翻。
2. **needs-input 怎么"叫人"？** 顶部 toast / sidebar 项目卡片右上角红点 / 当前任务卡片脉冲？三选一或组合。
3. **项目列表怎么排序 + 怎么处理"完成的项目"？** 默认按 `updatedAt` 倒序？已完成项目要不要折叠/归档区？

---

收到后跟上次一样：你做 visual，我做 wiring（迁到 `packages/ui` + 接 Shell + 跑 typecheck / dev verify / PR）。
