# Workspace Chat 运行编排浮窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在列表页与项目 board 内提供一个底部展开式对话浮窗,用户用自然语言让 Cogni 立即执行项目/任务的增删改(人能做的 AI 都能做)。

**Architecture:** runner-based。云端 `WorkspaceChatDomain` 把浮窗消息 dispatch 到 host 上的 Claude Code orchestrator runner(`orchestrator:true` 标志);该 runner 通过 `--mcp-config` 挂载本地 cogni stdio MCP server,工具调用回云端现有 REST(`Authorization: Host <token>`),云端 `ProjectDomain` 落库并广播,看板/列表实时更新。runner 流式输出由现有 `ChatDomain.handleHostEvent` 统一处理并推回浮窗。

**Tech Stack:** TypeScript (NodeNext ESM), Hono + @hono/node-ws, drizzle + Neon/pglite, vitest, React 19, `@modelcontextprotocol/sdk`(net-new), execa, Claude Code CLI。

---

## 锁定的关键设计决策(实现前必读)

1. **`threads.kind`**:新增列 `kind text NOT NULL DEFAULT 'chat'`。取值 `'chat' | 'workspace'`。**两种 orchestrator 线程都用 `'workspace'`**:工作区级(`project_id` 无关,每 user 一条,不被任何项目引用)和项目级(被 `projects.thread_id` 引用)统一 `kind='workspace'`。路由规则:`thread.kind === 'workspace'` → `WorkspaceChatDomain`。
2. **删除事件复用现有协议**:
   - 任务删除 = `task-event { kind: "deleted", task }`(契约 + UI `applyTaskEvent` 已支持,**无需改 UI 任务侧**)。
   - 项目删除 = 给 `PROJECT_EVENT_KINDS` 增加 `"deleted"` + UI `applyProjectEvent` 增一分支。
3. **删除项目 = 硬删除级联**:逐个 `deleteTask`(running 先 cancel runner)后删项目行 + 关联 thread。无撤销窗口。
4. **runner 事件统一处理**:`ChatDomain.handleHostEvent` 处理所有 session(含 orchestrator),host-ws 不改。`WorkspaceChatDomain` 只负责 send/dispatch。
5. **orchestrator cwd**:不设 `workspacePath`,沿用 `threadScratchDir(threadId)`(中性目录),它只调 MCP 工具不碰文件。
6. **host-auth**:`Authorization: Host <registrationToken>` 经 `findHostByToken` 解析为其所属 user。MCP server 读本机 `~/.cogni/host.json` 拿 token,无需 per-dispatch 身份。
7. **MCP server 进程**:作为 runner-host 二进制的 `mcp-serve` 子命令运行(兼容 `node dist/main.js mcp-serve` 与编译版 sidecar)。

## 文件清单

**新建**
- `packages/runner-host/src/mcp/cogni-tools.ts` — cogni stdio MCP server + 工具→REST。
- `packages/runner-host/src/mcp/mcp-config.ts` — 生成 `cogni-mcp.json` + 工具名常量。
- `packages/ui/src/components/project/WorkspaceChatBar.tsx`(+ `workspace-chat.css`)。
- `packages/cloud/src/domains/workspace-chat.ts` — `WorkspaceChatDomain`。
- `packages/cloud/src/scripts/migrate-2026-05-20-thread-kind.ts` — 加 `kind` 列。

**修改**
- `packages/contract/src/project.ts` — `PROJECT_EVENT_KINDS` 加 `"deleted"`。
- `packages/contract/src/protocol.ts` — dispatch 帧加 `orchestrator?: boolean`。
- `packages/contract/src/runner.ts` — `StartSessionOpts` 加 `mcpConfigPath?` / `allowedTools?`。
- `packages/cloud/src/db/schema.ts` — `threads.kind`。
- `packages/cloud/src/db/threads.ts` — `getOrCreateWorkspaceThread`、`getOrCreateProjectThread`、`getThreadKind`。
- `packages/cloud/src/db/projects.ts` — `deleteTask`、`deleteProject`、`getProjectByThreadId`。
- `packages/cloud/src/domains/project/index.ts` — `ProjectDomain.deleteTask` / `deleteProject`。
- `packages/cloud/src/routes/projects.ts` — `DELETE /api/tasks/:taskId`、`DELETE /api/projects/:id`、`GET /api/workspace-thread`、`GET /api/projects/:id/chat-thread`。
- `packages/cloud/src/routes/client.ts` — `/api/*` host-auth 分支;`send` 帧按 thread.kind 路由。
- `packages/cloud/src/server.ts` / `main.ts` — 注入 `workspaceChat`。
- `packages/runner-host/src/adapters/claude-code.ts` — 透传 mcp 选项到 spawn args。
- `packages/runner-host/src/runner-manager.ts` — `DispatchInput.orchestrator` → 注入 mcp 配置。
- `packages/runner-host/src/registry.ts` — dispatch 帧透传 `orchestrator`。
- `packages/runner-host/src/main.ts` — `mcp-serve` 子命令。
- `packages/runner-host/package.json` — 加 `@modelcontextprotocol/sdk`。
- `packages/ui/src/components/Composer.tsx` — 可选 `placeholder` prop。
- `packages/ui/src/hooks/useProjects.ts` — `applyProjectEvent` 加 `"deleted"` 分支。
- `apps/web/src/App.tsx`、`apps/desktop/src/Shell.tsx` — 挂载 `WorkspaceChatBar`。

---

# Phase 1 — 后端基础(删除 + 项目删除事件 + host-auth)

可独立交付与测试,先落。

## Task 1: db 层 deleteTask / deleteProject / getProjectByThreadId

**Files:**
- Modify: `packages/cloud/src/db/projects.ts`
- Test: `packages/cloud/src/db/projects.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/cloud/src/db/projects.test.ts` 末尾追加(沿用文件已有的 `makeTestDb` / 建 user+project 的 helper;若无则参考 `db/schema.test.ts` 的建库方式):

```ts
import { deleteTask, deleteProject, getProjectByThreadId, createProject, createTask, getTask, getProject } from "./projects.js";

it("deleteTask removes the row", async () => {
  const { db } = await makeTestDb();
  const project = await createProject(db, { userId: U, tenantId: T, name: "P", repoPath: "/tmp/p" });
  const task = await createTask(db, { projectId: project.id, title: "t" });
  await deleteTask(db, task.id);
  expect(await getTask(db, task.id)).toBeNull();
});

it("deleteProject cascades tasks and removes project", async () => {
  const { db } = await makeTestDb();
  const project = await createProject(db, { userId: U, tenantId: T, name: "P", repoPath: "/tmp/p" });
  const task = await createTask(db, { projectId: project.id, title: "t" });
  await deleteProject(db, project.id);
  expect(await getProject(db, project.id)).toBeNull();
  expect(await getTask(db, task.id)).toBeNull();
});

it("getProjectByThreadId finds the project linked via thread_id", async () => {
  const { db } = await makeTestDb();
  const project = await createProject(db, { userId: U, tenantId: T, name: "P", repoPath: "/tmp/p", threadId: null });
  expect(await getProjectByThreadId(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
});
```

> 注:`U`/`T` 为测试里已建好的 user/tenant id;复用文件顶部既有 setup。若 `createProject` 的 `CreateProjectInput` 不接受 `threadId`,删掉该字段(threadId 由 Task 9 的 helper 后置设置)。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/cloud/src/db/projects.test.ts`
Expected: FAIL — `deleteTask`/`deleteProject`/`getProjectByThreadId` is not a function。

- [ ] **Step 3: 实现**

在 `packages/cloud/src/db/projects.ts` 增加(import 顶部已有 `eq`、`projects`、`projectTasks`;若 `projectTasks` 未导入则从 `./schema.js` 引入,表名以 schema 实际导出为准):

```ts
export async function getProjectByThreadId(db: AnyDb, threadId: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.threadId, threadId)).limit(1);
  return row ? rowToProject(row) : null;
}

export async function deleteTask(db: AnyDb, taskId: string): Promise<void> {
  await db.delete(projectTasks).where(eq(projectTasks.id, taskId));
}

export async function deleteProject(db: AnyDb, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(projectTasks).where(eq(projectTasks.projectId, projectId));
    await tx.delete(projects).where(eq(projects.id, projectId));
  });
}
```

> `rowToProject` 是文件内已有的行→`Project` 映射(`getProject` 用的同一个);若名字不同,复用 `getProject` 里的同款映射。`runner_sessions.task_id` 已是 `onDelete: "set null"`,删 task 不会孤儿。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/cloud/src/db/projects.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cloud/src/db/projects.ts packages/cloud/src/db/projects.test.ts
git commit -m "feat(cloud): db deleteTask/deleteProject/getProjectByThreadId"
```

## Task 2: 契约 — PROJECT_EVENT_KINDS 加 "deleted"

**Files:**
- Modify: `packages/contract/src/project.ts:245`
- Test: 既有 contract 测试(若无专门测试,靠 typecheck 守住)

- [ ] **Step 1: 改实现**

```ts
export const PROJECT_EVENT_KINDS = ["created", "updated", "archived", "deleted"] as const;
```

- [ ] **Step 2: typecheck**

Run: `pnpm build`
Expected: 无报错(`projectEventKindSchema` 自动含新 kind)。

- [ ] **Step 3: 提交**

```bash
git add packages/contract/src/project.ts
git commit -m "feat(contract): add 'deleted' to PROJECT_EVENT_KINDS"
```

## Task 3: ProjectDomain.deleteTask / deleteProject

**Files:**
- Modify: `packages/cloud/src/domains/project/index.ts`
- Test: `packages/cloud/src/domains/project/delete.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

新建 `packages/cloud/src/domains/project/delete.test.ts`(参考同目录 `lifecycle.test.ts` 的 `makeTestDb` + 构造 `ProjectDomain` 的方式,clients/hostRpc 用 spy):

```ts
import { describe, it, expect, vi } from "vitest";
// ... 复用 lifecycle.test.ts 顶部的 makeProjectDomain helper(db + fake clients/hostRpc)

it("deleteTask cancels running runner then broadcasts task-event deleted", async () => {
  const { domain, clients, db } = await makeProjectDomain();
  const project = await createProject(db, { userId: U, tenantId: T, name: "P", repoPath: "/tmp/p" });
  const task = await createTask(db, { projectId: project.id, title: "t" });
  await domain.deleteTask(task.id);
  expect(await getTask(db, task.id)).toBeNull();
  expect(clients.broadcastProject).toHaveBeenCalledWith(
    project.id,
    expect.objectContaining({ t: "task-event", kind: "deleted" }),
  );
});

it("deleteProject removes tasks + project and broadcasts project-event deleted", async () => {
  const { domain, clients, db } = await makeProjectDomain();
  const project = await createProject(db, { userId: U, tenantId: T, name: "P", repoPath: "/tmp/p" });
  await createTask(db, { projectId: project.id, title: "t" });
  await domain.deleteProject(project.id);
  expect(await getProject(db, project.id)).toBeNull();
  expect(clients.broadcastProjects).toHaveBeenCalledWith(
    project.userId,
    expect.objectContaining({ t: "project-event", kind: "deleted" }),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/cloud/src/domains/project/delete.test.ts`
Expected: FAIL — `domain.deleteTask` is not a function。

- [ ] **Step 3: 实现**

在 `index.ts` import 增 `deleteTask as dbDeleteTask, deleteProject as dbDeleteProject` from `../../db/projects.js`,并在 `ProjectDomain` 内新增方法(放在 `cancelTask` 之后):

```ts
async deleteTask(taskId: string): Promise<void> {
  const task = await dbGetTask(this.deps.db, taskId);
  if (!task) return; // idempotent
  const terminal = task.state === "done" || task.state === "failed" || task.state === "cancelled";
  if (!terminal) {
    try { await this.cancelTask(taskId); } catch (err) {
      this.deps.logger?.warn?.({ taskId, err: String(err) }, "deleteTask: cancel before delete failed; deleting anyway");
    }
  }
  await dbDeleteTask(this.deps.db, taskId);
  this.deps.clients.broadcastProject(task.projectId, { t: "task-event", kind: "deleted", task });
  this.deps.clients.broadcastTask(task.id, { t: "task-event", kind: "deleted", task });
}

async deleteProject(projectId: string): Promise<void> {
  const project = await dbGetProject(this.deps.db, projectId);
  if (!project) return;
  const tasks = await dbListTasksByProject(this.deps.db, projectId);
  for (const t of tasks) await this.deleteTask(t.id);
  await dbDeleteProject(this.deps.db, projectId);
  this.deps.clients.broadcastProjects(project.userId, { t: "project-event", kind: "deleted", project });
  this.deps.clients.broadcastProject(project.id, { t: "project-event", kind: "deleted", project });
}
```

> `cancelTask` 已处理 worktree-remove + 关 runner session,故 deleteTask 复用它即可。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/cloud/src/domains/project/delete.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cloud/src/domains/project/index.ts packages/cloud/src/domains/project/delete.test.ts
git commit -m "feat(cloud): ProjectDomain.deleteTask/deleteProject with broadcasts"
```

## Task 4: DELETE 路由

**Files:**
- Modify: `packages/cloud/src/routes/projects.ts`
- Test: `packages/cloud/src/routes/projects.test.ts`(若存在则追加;否则参考 `routes/hosts.test.ts` 的 app+req setup 新建)

- [ ] **Step 1: 写失败测试**

```ts
it("DELETE /api/tasks/:taskId removes the task (200)", async () => {
  const { req, taskId } = await setupWithTask();
  const res = await req(`/api/tasks/${taskId}`, { method: "DELETE" });
  expect(res.status).toBe(200);
});

it("DELETE /api/projects/:id removes the project (200)", async () => {
  const { req, projectId } = await setupWithProject();
  const res = await req(`/api/projects/${projectId}`, { method: "DELETE" });
  expect(res.status).toBe(200);
});

it("DELETE /api/tasks/:taskId of another user → 404", async () => {
  const { reqOther, taskId } = await setupWithTask();
  const res = await reqOther(`/api/tasks/${taskId}`, { method: "DELETE" });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/cloud/src/routes/projects.test.ts`
Expected: FAIL — 404/501 (路由未注册)。

- [ ] **Step 3: 实现**

在 `registerProjectsRoutes` 内,`cancel` 路由附近加:

```ts
app.delete("/api/tasks/:taskId", async (c) => {
  const { userId, tenantId } = c.get("claims");
  const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
  if (!owned) return c.json({ error: "not found" }, 404);
  if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
  try {
    await deps.projectDomain.deleteTask(owned.task.id);
    return c.json({ ok: true });
  } catch (err) {
    const { status, body } = domainErrorResponse(err);
    return c.json(body, status);
  }
});

app.delete("/api/projects/:id", async (c) => {
  const { userId, tenantId } = c.get("claims");
  const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
  if (!project) return c.json({ error: "not found" }, 404);
  if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
  try {
    await deps.projectDomain.deleteProject(project.id);
    return c.json({ ok: true });
  } catch (err) {
    const { status, body } = domainErrorResponse(err);
    return c.json(body, status);
  }
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/cloud/src/routes/projects.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cloud/src/routes/projects.ts packages/cloud/src/routes/projects.test.ts
git commit -m "feat(cloud): DELETE task + project routes"
```

## Task 5: host-auth 中间件(`Authorization: Host <token>`)

**Files:**
- Modify: `packages/cloud/src/routes/client.ts:72-84`
- Test: `packages/cloud/src/routes/projects.test.ts`(追加)

- [ ] **Step 1: 写失败测试**

```ts
it("Host <token> auth lets a registered host act as its owner", async () => {
  const { app, host, projectId } = await setupWithProject(); // host belongs to same user
  const res = await app.request(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    headers: { Authorization: `Host ${host.registrationToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "via host" }),
  });
  expect(res.status).toBe(201);
});

it("unknown Host token → 401", async () => {
  const { app } = await setupWithProject();
  const res = await app.request(`/api/projects`, {
    method: "GET", headers: { Authorization: "Host nope" },
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/cloud/src/routes/projects.test.ts -t "Host"`
Expected: FAIL — 401 (Host scheme 未识别)。

- [ ] **Step 3: 实现**

在 `client.ts` 的 `/api/*` 中间件里,Bearer 解析之后、`if (!claims)` 之前插入 Host 分支(import `findHostByToken` from `../db/hosts.js`):

```ts
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/ws") return next();
  const auth = c.req.header("Authorization");
  // Host-token path: a registered runner host acts as its owning user.
  if (auth?.startsWith("Host ")) {
    const host = await findHostByToken(deps.db, auth.slice(5));
    if (!host) return c.json({ error: "unauthorized" }, 401);
    c.set("claims", { userId: host.userId, tenantId: host.tenantId, sessionId: `host:${host.id}` });
    return next();
  }
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const claims = token ? await deps.auth.verifyToken(token) : null;
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  const session = await getAuthSession(deps.db, claims.sessionId);
  if (!session || session.revokedAt !== null) return c.json({ error: "unauthorized" }, 401);
  c.set("claims", claims);
  void touchAuthSession(deps.db, claims.sessionId).catch(() => undefined);
  await next();
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/cloud/src/routes/projects.test.ts -t "Host"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cloud/src/routes/client.ts packages/cloud/src/routes/projects.test.ts
git commit -m "feat(cloud): Host-token auth path for runner-host REST callbacks"
```

---

# Phase 2 — cogni MCP server + adapter mcp-config

## Task 6: 加 `@modelcontextprotocol/sdk` 依赖

**Files:** `packages/runner-host/package.json`

- [ ] **Step 1: 安装**

Run: `pnpm --filter @cogni/runner-host add @modelcontextprotocol/sdk`
Expected: lockfile 更新,`dependencies` 出现该包。

- [ ] **Step 2: 提交**

```bash
git add packages/runner-host/package.json pnpm-lock.yaml
git commit -m "build(runner-host): add @modelcontextprotocol/sdk"
```

## Task 7: 透传 mcp 选项到 Claude Code spawn args

**Files:**
- Modify: `packages/contract/src/runner.ts:28-31`
- Modify: `packages/runner-host/src/adapters/claude-code.ts`
- Test: `packages/runner-host/src/adapters/claude-code.test.ts`(追加)

- [ ] **Step 1: 写失败测试**

在 adapter 测试里(该文件已用注入式 `ClaudeRunner` 测 translate;新增对 spawn args 的测试需断言传入 runner 的参数)。最简做法:断言 `ClaudeCodeSession` 把 opts 透传给 runner:

```ts
it("passes mcpConfigPath + allowedTools through to the runner", async () => {
  const seen: any[] = [];
  const runner: ClaudeRunner = async function* (p) { seen.push(p); yield JSON.stringify({ type: "result", subtype: "success" }); };
  const adapter = new ClaudeCodeAdapter(runner);
  const session = await adapter.startSession({ cwd: "/tmp", mcpConfigPath: "/tmp/cogni-mcp.json", allowedTools: ["mcp__cogni__create_task"] });
  for await (const _ of session.send("hi")) { /* drain */ }
  expect(seen[0]).toMatchObject({ mcpConfigPath: "/tmp/cogni-mcp.json", allowedTools: ["mcp__cogni__create_task"] });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/runner-host/src/adapters/claude-code.test.ts -t "mcpConfigPath"`
Expected: FAIL — 类型/字段缺失。

- [ ] **Step 3: 实现**

`contract/src/runner.ts` `StartSessionOpts`:

```ts
export interface StartSessionOpts {
  cwd: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
}
```

`adapters/claude-code.ts`:
- 扩 `ClaudeRunner` 参数:`{ cwd; message; resumeId; mcpConfigPath?: string; allowedTools?: string[] }`。
- `defaultClaudeRunner` 在 `--resume` push 之后追加:
```ts
if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
if (allowedTools && allowedTools.length) args.push("--allowed-tools", allowedTools.join(","));
```
- `ClaudeCodeSession` 构造增 `private readonly opts: { mcpConfigPath?: string; allowedTools?: string[] }`,并在 line 88 的 `this.runner({...})` 调用里带上 `mcpConfigPath: this.opts.mcpConfigPath, allowedTools: this.opts.allowedTools`。
- `startSession`/`resumeSession` 把 `{ mcpConfigPath: opts.mcpConfigPath, allowedTools: opts.allowedTools }` 传进 session 构造。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/runner-host/src/adapters/claude-code.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/contract/src/runner.ts packages/runner-host/src/adapters/claude-code.ts packages/runner-host/src/adapters/claude-code.test.ts
git commit -m "feat(runner-host): claude adapter accepts --mcp-config/--allowed-tools"
```

## Task 8: cogni MCP config 生成 + 工具名常量

**Files:**
- Create: `packages/runner-host/src/mcp/mcp-config.ts`
- Test: `packages/runner-host/src/mcp/mcp-config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { COGNI_TOOL_NAMES, COGNI_ALLOWED_TOOLS, ensureCogniMcpConfig } from "./mcp-config.js";
import { readFileSync } from "node:fs";

it("COGNI_ALLOWED_TOOLS namespaces every tool under mcp__cogni__", () => {
  expect(COGNI_ALLOWED_TOOLS).toContain("mcp__cogni__create_task");
  expect(COGNI_ALLOWED_TOOLS.length).toBe(COGNI_TOOL_NAMES.length);
});

it("ensureCogniMcpConfig writes a config pointing at the mcp-serve subcommand", () => {
  const path = ensureCogniMcpConfig();
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  expect(cfg.mcpServers.cogni.args).toContain("mcp-serve");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/runner-host/src/mcp/mcp-config.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.js";

export const COGNI_TOOL_NAMES = [
  "list_projects", "list_tasks",
  "create_task", "cancel_task", "delete_task",
  "accept_task", "reject_task", "retry_task", "reply_task",
  "create_project", "rename_project", "delete_project",
] as const;

export const COGNI_ALLOWED_TOOLS = COGNI_TOOL_NAMES.map((n) => `mcp__cogni__${n}`);

/** Launch command for the cogni MCP server = this same binary with `mcp-serve`.
 *  Works for `node dist/main.js` (execPath=node, argv[1]=script) and the
 *  compiled sidecar (execPath=binary, no argv[1]). */
export function cogniMcpServerCommand(): { command: string; args: string[] } {
  const script = process.argv[1];
  const args = script ? [script, "mcp-serve"] : ["mcp-serve"];
  return { command: process.execPath, args };
}

export function ensureCogniMcpConfig(): string {
  const path = join(configDir(), "cogni-mcp.json");
  const { command, args } = cogniMcpServerCommand();
  writeFileSync(path, JSON.stringify({ mcpServers: { cogni: { command, args } } }, null, 2));
  return path;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/runner-host/src/mcp/mcp-config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/runner-host/src/mcp/mcp-config.ts packages/runner-host/src/mcp/mcp-config.test.ts
git commit -m "feat(runner-host): cogni mcp-config generator + tool names"
```

## Task 9: cogni stdio MCP server(工具 → 云端 REST)

**Files:**
- Create: `packages/runner-host/src/mcp/cogni-tools.ts`
- Test: `packages/runner-host/src/mcp/cogni-tools.test.ts`

- [ ] **Step 1: 写失败测试**

测试聚焦"工具 → REST 映射 + Host 鉴权头",把网络层做成可注入(导出一个纯函数 `callCogniTool(deps, name, args)`,`deps.fetch` 可 mock,`deps.config` 提供 cloudUrl/token):

```ts
import { callCogniTool, httpBaseFromWsUrl } from "./cogni-tools.js";

it("httpBaseFromWsUrl converts ws→http and wss→https", () => {
  expect(httpBaseFromWsUrl("ws://localhost:8787")).toBe("http://localhost:8787");
  expect(httpBaseFromWsUrl("wss://chat.ai-cognit.com")).toBe("https://chat.ai-cognit.com");
});

it("create_task POSTs to /api/projects/:id/tasks with Host auth", async () => {
  const calls: any[] = [];
  const fetchMock = async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => ({ id: "t1", title: "x" }) } as any;
  };
  const out = await callCogniTool(
    { fetch: fetchMock, config: { cloudUrl: "ws://localhost:8787", registrationToken: "tok", hostId: "h" } },
    "create_task",
    { projectId: "p1", title: "x" },
  );
  expect(calls[0].url).toBe("http://localhost:8787/api/projects/p1/tasks");
  expect(calls[0].init.method).toBe("POST");
  expect(calls[0].init.headers.Authorization).toBe("Host tok");
  expect(out).toContain("t1");
});

it("delete_project DELETEs to /api/projects/:id", async () => {
  const calls: any[] = [];
  const fetchMock = async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) } as any; };
  await callCogniTool({ fetch: fetchMock, config: { cloudUrl: "ws://x", registrationToken: "t", hostId: "h" } }, "delete_project", { projectId: "p9" });
  expect(calls[0].init.method).toBe("DELETE");
  expect(calls[0].url).toBe("http://x/api/projects/p9");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/runner-host/src/mcp/cogni-tools.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readHostConfig, type HostConfig } from "../config.js";
import { COGNI_TOOL_NAMES } from "./mcp-config.js";

export function httpBaseFromWsUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http"); // ws→http, wss→https
}

interface ToolDeps {
  fetch: typeof globalThis.fetch;
  config: Pick<HostConfig, "cloudUrl" | "registrationToken"> & { hostId?: string };
}

interface ToolRoute { method: string; path: (a: any) => string; body?: (a: any) => unknown; }

const ROUTES: Record<string, ToolRoute> = {
  list_projects:  { method: "GET",    path: () => `/api/projects` },
  list_tasks:     { method: "GET",    path: (a) => `/api/projects/${a.projectId}/tasks` },
  create_task:    { method: "POST",   path: (a) => `/api/projects/${a.projectId}/tasks`, body: (a) => ({ title: a.title, description: a.description, priority: a.priority, labels: a.labels, adapter: a.adapter }) },
  cancel_task:    { method: "POST",   path: (a) => `/api/tasks/${a.taskId}/cancel` },
  delete_task:    { method: "DELETE", path: (a) => `/api/tasks/${a.taskId}` },
  accept_task:    { method: "POST",   path: (a) => `/api/tasks/${a.taskId}/accept` },
  reject_task:    { method: "POST",   path: (a) => `/api/tasks/${a.taskId}/reject` },
  retry_task:     { method: "POST",   path: (a) => `/api/tasks/${a.taskId}/retry` },
  reply_task:     { method: "POST",   path: (a) => `/api/tasks/${a.taskId}/reply`, body: (a) => ({ content: a.content }) },
  create_project: { method: "POST",   path: () => `/api/projects`, body: (a) => ({ name: a.name, repoPath: a.repoPath, description: a.description }) },
  rename_project: { method: "PATCH",  path: (a) => `/api/projects/${a.projectId}`, body: (a) => ({ name: a.name }) },
  delete_project: { method: "DELETE", path: (a) => `/api/projects/${a.projectId}` },
};

export async function callCogniTool(deps: ToolDeps, name: string, args: any): Promise<string> {
  const route = ROUTES[name];
  if (!route) throw new Error(`unknown tool: ${name}`);
  const url = httpBaseFromWsUrl(deps.config.cloudUrl) + route.path(args);
  const init: any = {
    method: route.method,
    headers: { Authorization: `Host ${deps.config.registrationToken}`, "Content-Type": "application/json" },
  };
  if (route.body) init.body = JSON.stringify(route.body(args));
  const res = await deps.fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return JSON.stringify({ error: true, status: res.status, body: json });
  return JSON.stringify(json);
}

// Minimal JSON-schema per tool (kept loose; the orchestrator prompt guides usage).
const INPUT_SCHEMAS: Record<string, object> = {
  list_projects: { type: "object", properties: {} },
  list_tasks: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
  create_task: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, description: { type: "string" } }, required: ["projectId", "title"] },
  cancel_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  delete_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  accept_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  reject_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  retry_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  reply_task: { type: "object", properties: { taskId: { type: "string" }, content: { type: "string" } }, required: ["taskId", "content"] },
  create_project: { type: "object", properties: { name: { type: "string" }, repoPath: { type: "string" } }, required: ["name", "repoPath"] },
  rename_project: { type: "object", properties: { projectId: { type: "string" }, name: { type: "string" } }, required: ["projectId", "name"] },
  delete_project: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
};

export async function startCogniMcpServer(): Promise<void> {
  const config = await readHostConfig();
  if (!config) throw new Error("cogni mcp-serve: no ~/.cogni/host.json");
  const deps: ToolDeps = { fetch: globalThis.fetch, config };
  const server = new Server({ name: "cogni", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: COGNI_TOOL_NAMES.map((name) => ({ name, description: `cogni ${name}`, inputSchema: INPUT_SCHEMAS[name]! })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const text = await callCogniTool(deps, req.params.name, req.params.arguments ?? {});
    return { content: [{ type: "text", text }] };
  });
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/runner-host/src/mcp/cogni-tools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/runner-host/src/mcp/cogni-tools.ts packages/runner-host/src/mcp/cogni-tools.test.ts
git commit -m "feat(runner-host): cogni stdio MCP server (tools → cloud REST)"
```

## Task 10: `mcp-serve` 子命令 + orchestrator dispatch 注入

**Files:**
- Modify: `packages/runner-host/src/main.ts`
- Modify: `packages/runner-host/src/runner-manager.ts:5-18,47-77`
- Modify: `packages/runner-host/src/registry.ts`(dispatch 帧 → DispatchInput)
- Modify: `packages/contract/src/protocol.ts:41-56`
- Test: `packages/runner-host/src/runner-manager.test.ts`(追加)

- [ ] **Step 1: 写失败测试**

```ts
it("orchestrator dispatch injects mcpConfigPath + cogni allowedTools", async () => {
  const seen: any[] = [];
  const adapter = { id: "claude-code", capabilities: [],
    startSession: async (opts: any) => { seen.push(opts); return { runnerSessionId: null, async *send() {}, async close() {} }; },
    resumeSession: async (_id: string, opts: any) => { seen.push(opts); return { runnerSessionId: null, async *send() {}, async close() {} }; },
  };
  const mgr = new RunnerManager();
  mgr.register(adapter as any);
  for await (const _ of mgr.dispatch({ sessionId: "s", threadId: "th", adapter: "claude-code", runnerSessionId: null, message: "hi", orchestrator: true })) { /* drain */ }
  expect(seen[0].mcpConfigPath).toMatch(/cogni-mcp\.json$/);
  expect(seen[0].allowedTools).toContain("mcp__cogni__create_task");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/runner-host/src/runner-manager.test.ts -t "orchestrator"`
Expected: FAIL — `orchestrator` 字段未透传。

- [ ] **Step 3: 实现**

- `contract/src/protocol.ts` dispatch object 加 `orchestrator: z.boolean().optional(),`。
- `runner-manager.ts` `DispatchInput` 加 `orchestrator?: boolean;`;在 `dispatch()` 构造 `StartSessionOpts` 处:
```ts
import { ensureCogniMcpConfig, COGNI_ALLOWED_TOOLS } from "./mcp/mcp-config.js";
const cwd = input.workspacePath ?? threadScratchDir(input.threadId);
const opts: StartSessionOpts = input.orchestrator
  ? { cwd, mcpConfigPath: ensureCogniMcpConfig(), allowedTools: [...COGNI_ALLOWED_TOOLS] }
  : { cwd };
// ... resumeSession(runnerSessionId, opts) / startSession(opts)
```
- `registry.ts` 在把 cloud 的 dispatch 帧映射进 `manager.dispatch({...})` 处加 `orchestrator: msg.orchestrator`。
- `main.ts` 顶部最前面:
```ts
if (process.argv.includes("mcp-serve")) {
  const { startCogniMcpServer } = await import("./mcp/cogni-tools.js");
  await startCogniMcpServer();
  // stdio server keeps the process alive via the transport; do not start the daemon.
} else {
  // ... existing daemon bootstrap ...
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/runner-host/src/runner-manager.test.ts && pnpm build`
Expected: PASS + 编译通过

- [ ] **Step 5: 提交**

```bash
git add packages/runner-host/src/main.ts packages/runner-host/src/runner-manager.ts packages/runner-host/src/registry.ts packages/contract/src/protocol.ts packages/runner-host/src/runner-manager.test.ts
git commit -m "feat(runner-host): mcp-serve subcommand + orchestrator dispatch wiring"
```

---

# Phase 3 — WorkspaceChatDomain + workspace thread

## Task 11: threads.kind 迁移 + schema + thread helpers

**Files:**
- Create: `packages/cloud/src/scripts/migrate-2026-05-20-thread-kind.ts`
- Modify: `packages/cloud/src/db/schema.ts:67-78`
- Modify: `packages/cloud/src/db/threads.ts`
- Test: `packages/cloud/src/db/threads.test.ts`(追加)

- [ ] **Step 1: 写失败测试**

```ts
import { getOrCreateWorkspaceThread, getOrCreateProjectThread, getThreadKind } from "./threads.js";

it("getOrCreateWorkspaceThread is idempotent per user and marks kind=workspace", async () => {
  const { db } = await makeTestDb();
  const a = await getOrCreateWorkspaceThread(db, { userId: U, tenantId: T });
  const b = await getOrCreateWorkspaceThread(db, { userId: U, tenantId: T });
  expect(a.id).toBe(b.id);
  expect(await getThreadKind(db, a.id)).toBe("workspace");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/cloud/src/db/threads.test.ts -t "workspace"`
Expected: FAIL — 函数不存在。

- [ ] **Step 3: 实现**

`schema.ts` `threads` 加列(放在 `title` 之后):
```ts
kind: text("kind").notNull().default("chat"),
```
迁移脚本 `migrate-2026-05-20-thread-kind.ts`(照搬 `migrate-2026-05-20-thread-soft-delete.ts` 头部):
```ts
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";
const env = loadEnv();
const sql = neon(env.databaseUrl);
await sql`ALTER TABLE threads ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat'`;
console.log("threads.kind added");
```
`threads.ts` 新增(import `eq, and, isNull` from drizzle):
```ts
export async function getThreadKind(db: AnyDb, threadId: string): Promise<string | null> {
  const [row] = await db.select({ kind: threads.kind }).from(threads).where(eq(threads.id, threadId)).limit(1);
  return row?.kind ?? null;
}

export async function getOrCreateWorkspaceThread(db: AnyDb, input: { userId: string; tenantId: string }): Promise<{ id: string }> {
  const [existing] = await db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.userId, input.userId), eq(threads.kind, "workspace"), isNull(threads.deletedAt))).limit(1);
  if (existing) return { id: existing.id };
  const [row] = await db.insert(threads)
    .values({ userId: input.userId, tenantId: input.tenantId, title: "Workspace", kind: "workspace" }).returning();
  return { id: row!.id };
}

/** Project-scoped orchestrator thread. Reuses projects.thread_id; lazily creates one (kind=workspace). */
export async function getOrCreateProjectThread(db: AnyDb, project: { id: string; userId: string; tenantId: string; threadId: string | null }): Promise<{ id: string }> {
  if (project.threadId) return { id: project.threadId };
  const [row] = await db.insert(threads)
    .values({ userId: project.userId, tenantId: project.tenantId, title: "Project chat", kind: "workspace" }).returning();
  await db.update(projects).set({ threadId: row!.id }).where(eq(projects.id, project.id));
  return { id: row!.id };
}
```
> `getOrCreateProjectThread` 需 import `projects` from `./schema.js`。

- [ ] **Step 4: 跑测试确认通过 + 应用迁移**

Run: `pnpm vitest run packages/cloud/src/db/threads.test.ts`
Expected: PASS
应用到 Neon(部署时):`pnpm --filter @cogni/cloud exec tsx --env-file=.env src/scripts/migrate-2026-05-20-thread-kind.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/cloud/src/db/schema.ts packages/cloud/src/db/threads.ts packages/cloud/src/db/threads.test.ts packages/cloud/src/scripts/migrate-2026-05-20-thread-kind.ts
git commit -m "feat(cloud): threads.kind + workspace/project orchestrator thread helpers"
```

## Task 12: WorkspaceChatDomain

**Files:**
- Create: `packages/cloud/src/domains/workspace-chat.ts`
- Test: `packages/cloud/src/domains/workspace-chat.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("handleClientSend dispatches an orchestrator frame to an online host", async () => {
  const { db } = await makeTestDb();
  const sends: any[] = [];
  const hosts = { getOnlineHostsForUser: () => [{ hostId: "h1", userId: U }],
    getHostByIdForUser: () => ({ hostId: "h1", userId: U, send: (m: any) => sends.push(m) }) } as any;
  const clients = { broadcast: () => {}, sendToConn: () => {}, sendToUser: () => {} } as any;
  const thread = await getOrCreateWorkspaceThread(db, { userId: U, tenantId: T });
  const domain = new WorkspaceChatDomain(db, hosts, clients);
  await domain.handleClientSend({ userId: U, threadId: thread.id, content: "建个任务", sourceClientId: "c1" });
  expect(sends[0]).toMatchObject({ t: "dispatch", orchestrator: true, threadId: thread.id });
});

it("sends no-host-online when no host is connected", async () => {
  const { db } = await makeTestDb();
  const conn: any[] = [];
  const hosts = { getOnlineHostsForUser: () => [] } as any;
  const clients = { sendToConn: (_: string, m: any) => conn.push(m) } as any;
  const thread = await getOrCreateWorkspaceThread(db, { userId: U, tenantId: T });
  const domain = new WorkspaceChatDomain(db, hosts, clients);
  await domain.handleClientSend({ userId: U, threadId: thread.id, content: "x", sourceClientId: "c1" });
  expect(conn[0]).toMatchObject({ t: "no-host-online", threadId: thread.id });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/cloud/src/domains/workspace-chat.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

镜像 `ChatDomain` 的 send/dispatch 路径,但 (a) dispatch 帧带 `orchestrator: true`,(b) 新 session 时按 scope 预置 preamble。事件流由 `ChatDomain.handleHostEvent` 统一接管,故本类**不实现** handleHostEvent。

```ts
import { randomUUID } from "node:crypto";
import type { AnyDb } from "../db/users.js";
import type { HostRouter } from "../host-router.js";
import type { ClientHub } from "../client-hub.js";
import { appendMessage, touchThread } from "../db/threads.js";
import { getProjectByThreadId } from "../db/projects.js";
import { getLatestSessionForThread, openRunnerSession, setRunnerSessionStatus } from "../db/sessions.js";

const ADAPTER = "claude-code";

function preamble(scope: { projectName?: string; projectId?: string }): string {
  const where = scope.projectId
    ? `你正在项目「${scope.projectName}」(projectId=${scope.projectId})内工作,任务相关工具默认用这个 projectId。`
    : `你在工作区级编排,跨所有项目。用 list_projects 找 projectId,指代不清时先向用户澄清。`;
  return [
    "你是 Cogni 的工作区编排助手。通过 cogni 工具直接增删改项目和任务。",
    where,
    "策略:用户意图明确就立即执行(含删除/取消,无需二次确认),执行后简述做了什么。",
    "破坏性操作前若目标不唯一,先用 list_tasks/list_projects 确认再动手。",
    "---",
  ].join("\n");
}

export class WorkspaceChatDomain {
  constructor(
    private readonly db: AnyDb,
    private readonly hosts: HostRouter,
    private readonly clients: ClientHub,
  ) {}

  async handleClientSend(input: { userId: string; threadId: string; content: string; sourceClientId: string }): Promise<void> {
    const { userId, threadId, content, sourceClientId } = input;
    const online = this.hosts.getOnlineHostsForUser(userId);
    if (online.length === 0) {
      this.clients.sendToConn(sourceClientId, { t: "no-host-online", threadId, pendingMessageId: randomUUID() });
      return;
    }
    const latest = await getLatestSessionForThread(this.db, threadId);
    const preferred = latest?.hostId ?? null;
    const chosen = (preferred && online.find((h) => h.hostId === preferred)) || online[0]!;
    await this.persistAndDispatch({ userId, threadId, content, hostId: chosen.hostId });
  }

  private async persistAndDispatch(p: { userId: string; threadId: string; content: string; hostId: string }): Promise<void> {
    const userMsg = await appendMessage(this.db, { threadId: p.threadId, role: "user", content: p.content });
    await touchThread(this.db, p.threadId);
    this.clients.broadcast(p.threadId, { t: "message", threadId: p.threadId, messageId: userMsg.id, role: "user", content: userMsg.content, createdAt: userMsg.createdAt });

    const latest = await getLatestSessionForThread(this.db, p.threadId);
    const reusable = latest && latest.hostId === p.hostId && latest.status !== "closed";
    const session = reusable ? latest : await openRunnerSession(this.db, { threadId: p.threadId, hostId: p.hostId, adapter: ADAPTER });
    await setRunnerSessionStatus(this.db, session.id, "running");

    let message = p.content;
    if (!reusable) {
      const project = await getProjectByThreadId(this.db, p.threadId);
      message = preamble(project ? { projectId: project.id, projectName: project.name } : {}) + "\n" + p.content;
    }

    const conn = this.hosts.getHostByIdForUser(p.userId, p.hostId);
    if (!conn) { await setRunnerSessionStatus(this.db, session.id, "failed"); this.clients.sendToUser(p.userId, { t: "host-status", online: false }); return; }
    conn.send({ t: "dispatch", sessionId: session.id, threadId: p.threadId, adapter: ADAPTER, runnerSessionId: session.runnerSessionId, message, orchestrator: true });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/cloud/src/domains/workspace-chat.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cloud/src/domains/workspace-chat.ts packages/cloud/src/domains/workspace-chat.test.ts
git commit -m "feat(cloud): WorkspaceChatDomain (orchestrator send/dispatch)"
```

## Task 13: 路由接线 — send 按 kind 分发 + thread-id 端点 + 注入

**Files:**
- Modify: `packages/cloud/src/server.ts:33-52`(ServerDeps 加 `workspaceChat`)
- Modify: `packages/cloud/src/main.ts`(构造 + 注入)
- Modify: `packages/cloud/src/routes/client.ts:228-234`(send 分发)
- Modify: `packages/cloud/src/routes/projects.ts`(两个 GET thread 端点)
- Test: `packages/cloud/src/routes/projects.test.ts`(追加 thread 端点测试)

- [ ] **Step 1: 写失败测试**

```ts
it("GET /api/workspace-thread returns a stable workspace thread id", async () => {
  const { req } = await setupWithProject();
  const a = await (await req("/api/workspace-thread")).json();
  const b = await (await req("/api/workspace-thread")).json();
  expect(a.threadId).toBe(b.threadId);
});

it("GET /api/projects/:id/chat-thread returns the project orchestrator thread", async () => {
  const { req, projectId } = await setupWithProject();
  const res = await req(`/api/projects/${projectId}/chat-thread`);
  expect((await res.json()).threadId).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/cloud/src/routes/projects.test.ts -t "thread"`
Expected: FAIL — 404。

- [ ] **Step 3: 实现**

`server.ts` `ServerDeps` 加 `workspaceChat: WorkspaceChatDomain;`(import 类型)。
`main.ts`:
```ts
const workspaceChat = new WorkspaceChatDomain(db, hosts, clients);
// ...将 workspaceChat 加入传给 register*Routes 的 deps 对象
```
`routes/projects.ts` 增两个端点(import `getOrCreateWorkspaceThread, getOrCreateProjectThread` from `../db/threads.js`):
```ts
app.get("/api/workspace-thread", async (c) => {
  const { userId, tenantId } = c.get("claims");
  const t = await getOrCreateWorkspaceThread(deps.db, { userId, tenantId });
  return c.json({ threadId: t.id });
});

app.get("/api/projects/:id/chat-thread", async (c) => {
  const { userId, tenantId } = c.get("claims");
  const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
  if (!project) return c.json({ error: "not found" }, 404);
  const t = await getOrCreateProjectThread(deps.db, { id: project.id, userId, tenantId, threadId: project.threadId ?? null });
  return c.json({ threadId: t.id });
});
```
`routes/client.ts` send 分发(import `getThreadKind` from `../db/threads.js`):
```ts
} else if (msg.t === "send") {
  const kind = await getThreadKind(deps.db, msg.threadId);
  if (kind === "workspace") {
    await deps.workspaceChat.handleClientSend({ userId: claims.userId, threadId: msg.threadId, content: msg.content, sourceClientId: clientId });
  } else {
    await deps.chat.handleClientSend({ /* 既有参数不变 */ });
  }
}
```
> `clientId`/`claims.userId` 用该 WS 连接既有变量(参考 line 200-230 上下文)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/cloud/src/routes/projects.test.ts && pnpm build`
Expected: PASS + 编译通过

- [ ] **Step 5: 提交**

```bash
git add packages/cloud/src/server.ts packages/cloud/src/main.ts packages/cloud/src/routes/client.ts packages/cloud/src/routes/projects.ts packages/cloud/src/routes/projects.test.ts
git commit -m "feat(cloud): route workspace sends to WorkspaceChatDomain + thread-id endpoints"
```

---

# Phase 4 — UI 浮窗

## Task 14: Composer 可选 placeholder + api 客户端方法

**Files:**
- Modify: `packages/ui/src/components/Composer.tsx:30-43,72`
- Modify: `packages/ui/src/transport/api.ts`(加 `getWorkspaceThread` / `getProjectChatThread`)
- Test: 无独立单测(由消费方覆盖);`pnpm build` 守类型。

- [ ] **Step 1: 改 Composer**

props 加 `placeholder?: string;`,line 72 的硬编码 `"想聊点什么?"` 改为 `placeholder ?? "想聊点什么?"`。

- [ ] **Step 2: 加 api 方法**

`api.ts` 增:
```ts
getWorkspaceThread(): Promise<{ threadId: string }> { return this.get("/api/workspace-thread"); }
getProjectChatThread(projectId: string): Promise<{ threadId: string }> { return this.get(`/api/projects/${projectId}/chat-thread`); }
```
> 用文件内既有的 `this.get` 私有助手(与 `getThread` 同款);若签名不同,照搬 `getThread` 的写法。

- [ ] **Step 3: typecheck**

Run: `pnpm build`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/components/Composer.tsx packages/ui/src/transport/api.ts
git commit -m "feat(ui): Composer placeholder prop + workspace/project chat-thread api"
```

## Task 15: applyProjectEvent 处理 "deleted"

**Files:**
- Modify: `packages/ui/src/hooks/useProjects.ts:35-47`
- Test: `packages/ui/src/hooks/useProjects.test.ts`(追加)

- [ ] **Step 1: 写失败测试**

```ts
it("applyProjectEvent removes a project on kind=deleted", () => {
  const p = { id: "p1" } as any;
  const next = applyProjectEvent([p], { t: "project-event", kind: "deleted", project: p } as any);
  expect(next).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/ui/src/hooks/useProjects.test.ts -t "deleted"`
Expected: FAIL — 仍返回 `[p]`(deleted 落到默认 replace 分支)。

- [ ] **Step 3: 实现**

`applyProjectEvent` 在 `created` 分支后加:
```ts
if (frame.kind === "deleted") {
  return cur.filter((p) => p.id !== frame.project.id);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/ui/src/hooks/useProjects.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/hooks/useProjects.ts packages/ui/src/hooks/useProjects.test.ts
git commit -m "feat(ui): remove project card on project-event deleted"
```

## Task 16: WorkspaceChatBar 组件

**Files:**
- Create: `packages/ui/src/components/project/WorkspaceChatBar.tsx`
- Create: `packages/ui/src/components/project/workspace-chat.css`
- Modify: `packages/ui/src/index.ts`(export)
- Test: `packages/ui/src/components/project/WorkspaceChatBar.test.tsx`(行为级,见下)

- [ ] **Step 1: 写失败测试**

用 jsdom 渲染,断言收起态显示输入条、点击展开出现消息区。最小断言(若仓库 UI 测试基建有限,至少断言组件可渲染 + placeholder 生效):

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceChatBar } from "./WorkspaceChatBar.js";

it("renders collapsed bar with scope placeholder and expands on focus", () => {
  const api = { getWorkspaceThread: async () => ({ threadId: "w1" }) } as any;
  render(<WorkspaceChatBar api={api} scope={{ kind: "workspace" }} />);
  const bar = screen.getByPlaceholderText(/帮你建任务/);
  fireEvent.focus(bar);
  expect(screen.getByTestId("wschat-popup")).toBeTruthy();
});
```
> 若 `@testing-library/react` 未在 devDeps,先 `pnpm --filter @cogni/ui add -D @testing-library/react`。仓库若无 jsdom UI 测试先例,可将本测试降级为对纯逻辑(scope→placeholder 文案映射函数 `scopePlaceholder(scope)`)的单测,并把该函数导出。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/ui/src/components/project/WorkspaceChatBar.test.tsx`
Expected: FAIL — 组件不存在。

- [ ] **Step 3: 实现**

```tsx
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../transport/api.js";
import { useThreadStream } from "../../hooks/useThreadStream.js";
import { buildTimeline } from "../chat-timeline.js";
import { UserMessage, AssistantText, AssistantBlocks } from "../ChatBlocks.js";
import { Composer } from "../Composer.js";
import "./workspace-chat.css";

export type WorkspaceChatScope =
  | { kind: "workspace" }
  | { kind: "project"; projectId: string; projectName: string };

export function scopePlaceholder(scope: WorkspaceChatScope): string {
  return scope.kind === "project"
    ? `在「${scope.projectName}」里…`
    : "让 Cogni 帮你建任务、关任务、整理项目…";
}

export function WorkspaceChatBar({ api, scope }: { api: ApiClient; scope: WorkspaceChatScope }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    const p = scope.kind === "project" ? api.getProjectChatThread(scope.projectId) : api.getWorkspaceThread();
    p.then((r) => { if (live) setThreadId(r.threadId); }).catch(() => {});
    return () => { live = false; };
  }, [api, scope.kind, scope.kind === "project" ? scope.projectId : ""]);

  return (
    <div className={"wschat" + (open ? " wschat--open" : "")}>
      {open && threadId && <WorkspaceChatPopup api={api} threadId={threadId} onClose={() => setOpen(false)} />}
      <input
        className="wschat__bar"
        placeholder={scopePlaceholder(scope)}
        onFocus={() => setOpen(true)}
        readOnly
      />
    </div>
  );
}

function WorkspaceChatPopup({ api, threadId, onClose }: { api: ApiClient; threadId: string; onClose: () => void }) {
  const { messages, events, hostOnline, connected, send } = useThreadStream(api, threadId);
  const { rows } = buildTimeline(messages, events);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 1e9 }); }, [rows.length]);

  const submit = () => { if (draft.trim() && send(draft)) setDraft(""); };
  const disabled = !connected || !hostOnline;

  return (
    <div className="wschat__popup" data-testid="wschat-popup">
      <div className="wschat__head">
        <span>Cogni 编排</span>
        <button className="wschat__close" onClick={onClose} aria-label="收起">×</button>
      </div>
      <div className="wschat__body" ref={scrollRef}>
        {rows.length === 0 && <div className="wschat__empty">告诉 Cogni 你想建/改/删什么任务或项目。</div>}
        {rows.map((row) => {
          if (row.kind === "user") return <UserMessage key={row.key} text={row.text} />;
          if (row.kind === "assistant-text") return <AssistantText key={row.key} text={row.text} />;
          if (row.kind === "system") return null;
          return <AssistantBlocks key={row.key} blocks={row.blocks} streaming={row.streaming} />;
        })}
      </div>
      <Composer
        draft={draft} setDraft={setDraft} onSubmit={submit} disabled={disabled}
        status={disabled ? { kind: "danger", text: "需要本地 Cogni 在线才能编排" } : undefined}
      />
    </div>
  );
}
```
`workspace-chat.css`(BEM + token,底部锚定 + 向上展开):
```css
.wschat { position: relative; padding: 0 32px 22px; }
.wschat__bar {
  width: 100%; height: 44px; padding: 0 16px;
  border: 1px solid var(--line); border-radius: var(--r-full);
  background: var(--surface); color: var(--ink); cursor: text;
}
.wschat__popup {
  position: absolute; left: 32px; right: 32px; bottom: 74px;
  max-height: 60vh; display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-3); box-shadow: 0 12px 40px rgba(0,0,0,0.18); overflow: hidden;
}
.wschat__head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line-soft); font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
.wschat__close { background: none; border: none; font-size: 18px; color: var(--muted); cursor: pointer; }
.wschat__body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.wschat__empty { color: var(--muted); font-size: 13px; padding: 16px 4px; }
```
`index.ts` 加 `export { WorkspaceChatBar } from "./components/project/WorkspaceChatBar.js";`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/ui/src/components/project/WorkspaceChatBar.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/project/WorkspaceChatBar.tsx packages/ui/src/components/project/workspace-chat.css packages/ui/src/index.ts packages/ui/src/components/project/WorkspaceChatBar.test.tsx
git commit -m "feat(ui): WorkspaceChatBar expand-up orchestrator popup"
```

## Task 17: 在两端挂载 WorkspaceChatBar

**Files:**
- Modify: `apps/web/src/App.tsx`(`.main` 内,`projects`/`project` 页)
- Modify: `apps/desktop/src/Shell.tsx`(同位置)
- Test: 手动验证(见末尾验收)。`pnpm build` 守类型。

- [ ] **Step 1: web 挂载**

`apps/web/src/App.tsx` 在 `.main` 容器内、各 `{page === ...}` 块之后加:
```tsx
{page === "projects" && <WorkspaceChatBar api={api} scope={{ kind: "workspace" }} />}
{page === "project" && board.project && (
  <WorkspaceChatBar api={api} scope={{ kind: "project", projectId: board.project.id, projectName: board.project.name }} />
)}
```
import:`import { WorkspaceChatBar } from "@cogni/ui";`(或既有 UI 引入路径)。

- [ ] **Step 2: desktop 挂载**

`apps/desktop/src/Shell.tsx` 同样在 `.main` 内、`page === "projects"` / `page === "project"` 块之后加同样两行(变量名按 Shell 实际:`activeProjectId` / `board`)。

- [ ] **Step 3: typecheck + 构建两端**

Run: `pnpm build && pnpm --filter web build`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/App.tsx apps/desktop/src/Shell.tsx
git commit -m "feat(apps): mount WorkspaceChatBar on projects list + project board"
```

---

# 收尾验证

- [ ] **全量测试 + 类型**:`pnpm test && pnpm typecheck`
- [ ] **应用迁移到 Neon**:`pnpm --filter @cogni/cloud exec tsx --env-file=.env src/scripts/migrate-2026-05-20-thread-kind.ts`
- [ ] **端到端手测**(按 CLAUDE.md「Verifying user-visible changes」先杀残留进程,确认跑的是新代码):
  1. `pnpm build` → 起 cloud(`pnpm --filter @cogni/cloud dev`)→ 起 runner-host daemon(`node dist/main.js`)→ host 显示 online。
  2. web 列表页:底部输入条 →「在贪吃蛇里建一个加排行榜的任务」→ 浮窗回执 + 贪吃蛇卡「排队」+1。
  3. 进入该项目 board:浮窗 placeholder 变项目名 →「把刚才那个任务删了」→ 卡片淡出消失。
  4. 列表页:「把叫 X 的项目删了」→ 项目卡消失。
  5. 停掉 daemon → 浮窗输入禁用 + 文案「需要本地 Cogni 在线才能编排」。
- [ ] **changelog**:按用户规范在 `changelog/` 写本次改动(`YYYYMMDD_HHMMSS.md`,Summary + Changes 分组)。

# 自检对照(plan vs spec)

- 能力全集(create/cancel/delete/accept/reject/retry/reply + project create/rename/delete)→ Task 9 ROUTES 全覆盖 ✓
- 全部立即执行无确认 → MCP 工具直连 REST,无 confirm 环节 ✓
- 两个入口(工作区级/项目级)→ Task 13 端点 + Task 16 scope + Task 17 挂载 ✓
- runner-based 架构 → Task 7-10 ✓
- 删除项目硬删除级联 → Task 1/3 ✓
- host 离线禁用态 → Task 16 disabled + status ✓
- thread kind='workspace' → Task 11 ✓
- 删除事件协议复用(task 已有 / project 新增)→ Task 2/15 ✓
