/**
 * mock — SP-3 extension. Adds projects + relates tasks to projects + adds
 * task threads + a few `needs-input` cases the UI demos against.
 *
 * Same conventions as handoff/src/mock.ts (which this file supersedes — copy
 * this one over the existing mock.ts). The original task/host/device shapes
 * are preserved so existing imports (Settings, Project) keep working.
 */

// ─── Hosts + Devices (unchanged from SP-1/2) ──────────────────────

export type DesignHost = {
  id: string;
  name: string;
  status: "online" | "offline";
  lastSeen: string;
  adapters: string[];
};

export const MOCK_HOSTS: DesignHost[] = [
  { id: "h-home", name: "Home MacBook Pro", status: "online",  lastSeen: "now",    adapters: ["claude-code"] },
  { id: "h-work", name: "Work MacBook Air", status: "online",  lastSeen: "3m ago", adapters: ["claude-code"] },
  { id: "h-mini", name: "Studio Mac mini",  status: "offline", lastSeen: "2h ago", adapters: ["claude-code"] },
];

export type DesignDevice = {
  id: string;
  kind: "desktop" | "web" | "phone";
  name: string;
  where: string;
  when: string;
  current: boolean;
  ip: string;
};

export const MOCK_DEVICES: DesignDevice[] = [
  { id: "d-mac",    kind: "desktop", name: "Desktop App",     where: "MacBook Pro · here", when: "just now",  current: true,  ip: "—" },
  { id: "d-mini",   kind: "desktop", name: "Desktop App",     where: "Studio Mac mini",     when: "2h ago",    current: false, ip: "198.51.100.7" },
  { id: "d-chrome", kind: "web",     name: "Chrome on macOS", where: "Work iMac",           when: "5m ago",    current: false, ip: "203.0.113.42" },
  { id: "d-ios",    kind: "web",     name: "Safari",          where: "iPhone 15 · LTE",     when: "yesterday", current: false, ip: "203.0.113.88" },
];

// ─── Projects (SP-3) ──────────────────────────────────────────────

export type ProjectSource =
  | { kind: "linear"; teamId: string }
  | { kind: "internal" }
  | { kind: "manual" };

export type DesignProject = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  liveRunners: number;
  queuedCount: number;
  needsInputCount: number;
  health: "ok" | "warn" | "error";
  archived?: boolean;
  pinned?: boolean;
  source?: ProjectSource;
  defaultHostId?: string;
  concurrencyLimit?: number;
  systemPrompt?: string;
};

export const MOCK_PROJECTS: DesignProject[] = [
  {
    id: "p-sp2",
    name: "SP-2 · 多端同步 + Web 客户端",
    description: "把账户、设备、host 三类管理面做好,让 web 瘦客户端能跑起来",
    createdAt: "2026-05-08",
    updatedAt: "just now",
    liveRunners: 3,
    queuedCount: 2,
    needsInputCount: 1,
    health: "warn",
    pinned: true,
    source: { kind: "linear", teamId: "COG" },
    defaultHostId: "h-home",
    concurrencyLimit: 4,
    systemPrompt: "你是这个项目的高级开发,熟悉 TS/Node/Tauri。优先写测试,提交前跑 typecheck。",
  },
  {
    id: "p-sp3",
    name: "SP-3 · 项目域",
    description: "AI worker 编排器,每任务一个 workspace,监督式重试",
    createdAt: "2026-05-14",
    updatedAt: "2h ago",
    liveRunners: 1,
    queuedCount: 0,
    needsInputCount: 0,
    health: "ok",
    pinned: true,
    source: { kind: "internal" },
    defaultHostId: "h-home",
    concurrencyLimit: 2,
  },
  {
    id: "p-bugs",
    name: "线上 bug 队列",
    description: "支持工单转任务,跑 24h",
    createdAt: "2026-04-22",
    updatedAt: "12m ago",
    liveRunners: 0,
    queuedCount: 4,
    needsInputCount: 2,
    health: "error",
    source: { kind: "linear", teamId: "BUG" },
    defaultHostId: "h-work",
    concurrencyLimit: 6,
  },
  {
    id: "p-docs",
    name: "文档自动化",
    description: "PR 合并后扫 diff,更新 docs/",
    createdAt: "2026-04-10",
    updatedAt: "1d ago",
    liveRunners: 0,
    queuedCount: 0,
    needsInputCount: 0,
    health: "ok",
    source: { kind: "manual" },
    concurrencyLimit: 1,
  },
  {
    id: "p-spike",
    name: "Tauri 2 menubar spike",
    description: "评估能否把 cogni 做成 menubar app",
    createdAt: "2026-03-30",
    updatedAt: "5d ago",
    liveRunners: 0,
    queuedCount: 0,
    needsInputCount: 0,
    health: "ok",
    source: { kind: "manual" },
    concurrencyLimit: 1,
  },
  {
    id: "p-sp1",
    name: "SP-1 · 脊梁",
    description: "穿透账户 + 数据 + runner + 多端拓扑的最小闭环",
    createdAt: "2026-02-12",
    updatedAt: "2 weeks ago",
    liveRunners: 0,
    queuedCount: 0,
    needsInputCount: 0,
    health: "ok",
    archived: true,
    source: { kind: "internal" },
  },
  {
    id: "p-demo",
    name: "Demo 视频脚本",
    description: "给融资 demo 准备的脚本草稿",
    createdAt: "2026-02-01",
    updatedAt: "3 weeks ago",
    liveRunners: 0,
    queuedCount: 0,
    needsInputCount: 0,
    health: "ok",
    archived: true,
    source: { kind: "manual" },
  },
];

// ─── Tasks (extended) ─────────────────────────────────────────────

export type DesignTask = {
  id: string;
  ref: string;
  /** New in SP-3 — every task belongs to exactly one project. */
  projectId: string;
  title: string;
  description?: string;
  state: "queued" | "running" | "needs-input" | "reviewing" | "done" | "failed";
  hostId: string | null;
  startedAt?: string;
  elapsed: string;
  progress: number;
  retries: number;
  activity: string;
  delta: string;
  /** New: link to a thread the user can open in chat to see the full transcript. */
  threadId?: string;
  /** Populated when state === 'needs-input'. */
  needsInput?: { what: string };
};

export const MOCK_TASKS: DesignTask[] = [
  { id: "T-101", ref: "COG-118", projectId: "p-sp2",  title: "Fix dispatcher race when host reconnects mid-stream", state: "running",     hostId: "h-home", startedAt: "4m ago",  elapsed: "4m 12s",  progress: 0.62, retries: 0, activity: "Editing host-router.ts",      delta: "+87 −34",  threadId: "th-101" },
  { id: "T-102", ref: "COG-121", projectId: "p-sp2",  title: "Add events.seq backfill migration",                  state: "running",     hostId: "h-work", startedAt: "12m ago", elapsed: "12m 04s", progress: 0.41, retries: 1, activity: "Running pnpm test --filter cloud", delta: "+22 −8",   threadId: "th-102" },
  { id: "T-103", ref: "COG-117", projectId: "p-sp2",  title: "Drop unused user_identities.email_normalized column", state: "reviewing",   hostId: "h-home", startedAt: "8m ago",  elapsed: "8m 33s",  progress: 1.0,  retries: 0, activity: "等你 review",                   delta: "+4 −18",   threadId: "th-103" },
  { id: "T-104", ref: "COG-124", projectId: "p-sp2",  title: "Sketch the multi-host fallback inline card",         state: "queued",      hostId: null,                                 elapsed: "—",       progress: 0,    retries: 0, activity: "等可用 runner",                  delta: "—" },
  { id: "T-105", ref: "COG-119", projectId: "p-sp2",  title: "Magic link emails landing in spam — investigate DKIM", state: "needs-input", hostId: "h-work", startedAt: "23m ago", elapsed: "23m 18s", progress: 0.72, retries: 2, activity: "需要授权:读 /etc/postfix",       delta: "0 0",     threadId: "th-105", needsInput: { what: "允许读 /etc/postfix?" } },
  { id: "T-106", ref: "COG-115", projectId: "p-bugs", title: "Move client-hub off in-memory Map to Redis pub/sub", state: "failed",      hostId: "h-mini", startedAt: "17m ago", elapsed: "17m 02s", progress: 0.55, retries: 3, activity: "失败:没有可用的 redis 实例",     delta: "+162 −41", threadId: "th-106" },
  { id: "T-107", ref: "COG-112", projectId: "p-sp1",  title: "Wire up Tauri deep-link for email magic callback",   state: "done",        hostId: "h-home", startedAt: "1d ago",  elapsed: "6m 19s",  progress: 1.0,  retries: 0, activity: "已合并到 main",                 delta: "+44 −12" },
  { id: "T-108", ref: "COG-127", projectId: "p-sp2",  title: "CORS allowlist for chat.ai-cognit.com",             state: "queued",      hostId: null,                                 elapsed: "—",       progress: 0,    retries: 0, activity: "等可用 runner",                  delta: "—" },
  { id: "T-109", ref: "BUG-31",  projectId: "p-bugs", title: "Web 端 magic-link 在 Safari 私密模式下不能跳转",      state: "needs-input", hostId: "h-work", startedAt: "1h ago",  elapsed: "1h 02m",  progress: 0.5,  retries: 2, activity: "需要测试账号凭据",                delta: "+12 −4",   threadId: "th-109", needsInput: { what: "提供一个 Safari 私密模式可登录的测试账号" } },
  { id: "T-110", ref: "BUG-29",  projectId: "p-bugs", title: "断网时输入框文字丢失",                                  state: "queued",      hostId: null,                                 elapsed: "—",       progress: 0,    retries: 0, activity: "等可用 runner",                  delta: "—" },
];

export const STATE_COLOR: Record<DesignTask["state"], string> = {
  queued:        "var(--muted)",
  running:       "var(--accent)",
  "needs-input": "var(--warn)",
  reviewing:     "oklch(60% 0.10 270)",
  done:          "var(--good)",
  failed:        "var(--bad)",
};

export const STATE_LABEL: Record<DesignTask["state"], string> = {
  queued:        "排队中",
  running:       "进行中",
  "needs-input": "等待输入",
  reviewing:     "待 review",
  done:          "已完成",
  failed:        "失败",
};

// ─── Task threads (for TaskDetail's embedded chat) ───────────────

/**
 * One canned chat thread per task that has a threadId. The embedded chat in
 * TaskDetail will render this through the existing ChatBlocks components.
 *
 * The shape mirrors the trimmed `MessageView[]` you'd get from
 * GET /threads/:id — when SP-3 lands, swap this for the real fetch.
 */
export type MockThreadMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "thinking";
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolStatus?: "running" | "done" | "error";
};

export const MOCK_TASK_THREADS: Record<string, MockThreadMessage[]> = {
  "th-101": [
    { id: "m1", role: "system",  content: "项目 SP-2 · system prompt 已注入。任务: Fix dispatcher race when host reconnects mid-stream." },
    { id: "m2", role: "user",    content: "看一下 `host-router.ts`,重连时 race 的 root cause 是什么?然后给修复方案。" },
    { id: "m3", role: "thinking",content: "需要先看代码再下结论。在 reconnect 流程里大概率是 `byUser` Map 的更新顺序问题。" },
    { id: "m4", role: "tool",    toolName: "Read", toolInput: "packages/cloud/src/host-router.ts", toolStatus: "done", toolResult: "(132 lines)", content: "" },
    { id: "m5", role: "assistant", content: "找到了。`HostRouter.register()` 先 push 到 `byUser`,再触发 `replayPending()` —— 但 replay 是 async,期间另一个 send-message 命中 picker 时拿到的还是旧 list。修复就两步:\n\n1. 把 register 改成一个 transactional close:\n```ts\nasync register(conn: HostConn) {\n  this.byUser.set(conn.userId, [...current, conn]);\n  await this.replayPending(conn);\n}\n```\n\n2. picker 增加一个 `awaiting-replay` 状态,期间排队不分发。\n\n要我直接改吗?" },
    { id: "m6", role: "user",    content: "改吧,顺手加个 test 覆盖 race scenario。" },
    { id: "m7", role: "tool",    toolName: "Edit", toolInput: "packages/cloud/src/host-router.ts", toolStatus: "running", content: "" },
  ],
  "th-105": [
    { id: "m1", role: "user", content: "为什么 magic link 邮件总是落到 spam?诊断一下,要进 prod 机器看。" },
    { id: "m2", role: "thinking", content: "几个可能:DKIM 没配 / SPF 漏了 / sender reputation 太低 / 内容触发了过滤。先看 mail headers。" },
    { id: "m3", role: "tool", toolName: "Bash", toolInput: "dig TXT _dmarc.ai-cognit.com", toolStatus: "done", toolResult: "v=DMARC1; p=none; rua=mailto:dmarc@ai-cognit.com", content: "" },
    { id: "m4", role: "assistant", content: "DMARC 是 `p=none`。这是 spam 的主要原因。需要再看 postfix 的 main.cf。" },
    { id: "m5", role: "tool", toolName: "Read", toolInput: "/etc/postfix/main.cf", toolStatus: "error", toolResult: "Permission denied: needs root", content: "" },
    { id: "m6", role: "assistant", content: "我需要 sudo 权限读 `/etc/postfix/main.cf`。可以授权吗?" },
  ],
  "th-103": [
    { id: "m1", role: "user", content: "把 `user_identities.email_normalized` 这一列删掉,从来没用过。" },
    { id: "m2", role: "tool", toolName: "Grep", toolInput: "email_normalized", toolStatus: "done", toolResult: "0 references in src/", content: "" },
    { id: "m3", role: "assistant", content: "确认无引用。已经生成 migration:\n```sql\nALTER TABLE user_identities DROP COLUMN email_normalized;\n```\nRun 了 `pnpm db:migrate:dry`,通过。等你 review 后我 commit。" },
  ],
};
