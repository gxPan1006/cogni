/**
 * SP-4 WorkspaceChatDomain — the orchestrator floating-bar's send/dispatch
 * path. Mirrors ChatDomain's send pipeline but (a) tags every dispatch frame
 * with `orchestrator: true` so the host mounts the cogni MCP server, and
 * (b) prefixes the first turn of a new session with an orchestrator preamble
 * that tells the runner it can directly mutate projects/tasks via cogni tools.
 *
 * What the user sees: the bottom Workspace Chat bar (on the list page and
 * inside a project board). Typing a request like "建个任务" + Enter shows the
 * user's bubble immediately, then the orchestrator runner streams its reply
 * and any project/task changes fan out live to the board/list. With no host
 * connected, the bar surfaces a "no host online" state instead.
 *
 * Per the locked design decision #4, the runner's event stream (text / done /
 * tool-call) is handled by the existing `ChatDomain.handleHostEvent` — this
 * class deliberately does NOT implement handleHostEvent. It only owns
 * send → persist → dispatch.
 */
import { randomUUID } from "node:crypto";
import type { AnyDb } from "../db/users.js";
import type { HostRouter } from "../host-router.js";
import type { ClientHub } from "../client-hub.js";
import { appendMessage, touchThread } from "../db/threads.js";
import { getProjectByThreadId, getTask } from "../db/projects.js";
import type { ProjectTask } from "@cogni/contract";
import {
  getLatestSessionForThread,
  openRunnerSession,
  setRunnerSessionStatus,
} from "../db/sessions.js";

const ADAPTER = "claude-code";

/**
 * Build the system preamble prepended to the first user turn of a new
 * orchestrator session. Scope is either project-level (a project references
 * this thread) or workspace-level (cross-project).
 */
const STATE_LABEL: Record<ProjectTask["state"], string> = {
  queued: "排队中",
  running: "进行中",
  "needs-input": "等待输入",
  reviewing: "待 review",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function preamble(scope: { projectName?: string; projectId?: string; task?: ProjectTask | null }): string {
  // Never interpolate a missing/blank name as the literal "undefined"/"null":
  // degrade to a placeholder and lean on the always-correct projectId.
  const name = scope.projectName?.trim() ? scope.projectName.trim() : "(未命名项目)";
  const where = scope.projectId
    ? `你正在项目「${name}」(projectId=${scope.projectId})内工作,任务相关工具默认用这个 projectId。`
    : `你在工作区级编排,跨所有项目。用 list_projects 找 projectId,指代不清时先向用户澄清。`;
  const lines = [
    "你是 Cogni 的工作区编排助手。通过 cogni 工具直接增删改项目和任务。",
    where,
  ];
  // The user opened a specific task card before sending — make the model treat
  // it as the default referent of vague phrasing ("这个" / "改一下" / "重跑").
  if (scope.task) {
    const t = scope.task;
    lines.push(
      `用户当前聚焦在任务 ${t.ref}「${t.title}」(taskId=${t.id},状态:${STATE_LABEL[t.state]})上。` +
        `这条消息若指代不明,默认就是针对这张卡;操作它时用上面的 taskId。`,
    );
    if (t.description?.trim()) lines.push(`该任务的描述:${t.description.trim()}`);
  }
  lines.push(
    "策略:用户意图明确就立即执行(含删除/取消,无需二次确认),执行后简述做了什么。",
    "破坏性操作前若目标不唯一,先用 list_tasks/list_projects 确认再动手。",
    "---",
  );
  return lines.join("\n");
}

export class WorkspaceChatDomain {
  constructor(
    private readonly db: AnyDb,
    private readonly hosts: HostRouter,
    private readonly clients: ClientHub,
  ) {}

  async handleClientSend(input: {
    userId: string;
    threadId: string;
    content: string;
    sourceClientId: string;
    /** SP-4: the task card the user had open when they sent (focus chip). */
    taskId?: string;
  }): Promise<void> {
    const { userId, threadId, content, sourceClientId, taskId } = input;
    const online = this.hosts.getOnlineHostsForUser(userId);
    if (online.length === 0) {
      this.clients.sendToConn(sourceClientId, {
        t: "no-host-online",
        threadId,
        pendingMessageId: randomUUID(),
      });
      return;
    }
    // Host preference: the host that last owned this thread (so --resume keeps
    // context) → the project's default host (project-scoped chat) → any online
    // host. The default-host step keeps a project's orchestration on the same
    // box its tasks run on instead of an arbitrary online host.
    const project = await getProjectByThreadId(this.db, threadId);
    const latest = await getLatestSessionForThread(this.db, threadId);
    const preferred = latest?.hostId ?? project?.defaultHostId ?? null;
    const chosen = (preferred && online.find((h) => h.hostId === preferred)) || online[0]!;
    await this.persistAndDispatch({ userId, threadId, content, hostId: chosen.hostId, project, taskId });
  }

  private async persistAndDispatch(p: {
    userId: string;
    threadId: string;
    content: string;
    hostId: string;
    project?: Awaited<ReturnType<typeof getProjectByThreadId>>;
    taskId?: string;
  }): Promise<void> {
    const userMsg = await appendMessage(this.db, {
      threadId: p.threadId,
      role: "user",
      content: p.content,
    });
    await touchThread(this.db, p.threadId);
    this.clients.broadcast(p.threadId, {
      t: "message",
      threadId: p.threadId,
      messageId: userMsg.id,
      role: "user",
      content: userMsg.content,
      createdAt: userMsg.createdAt,
    });

    const latest = await getLatestSessionForThread(this.db, p.threadId);
    const reusable = latest && latest.hostId === p.hostId && latest.status !== "closed";
    const session = reusable
      ? latest
      : await openRunnerSession(this.db, {
          threadId: p.threadId,
          hostId: p.hostId,
          adapter: ADAPTER,
        });
    await setRunnerSessionStatus(this.db, session.id, "running");

    // Orchestrator framing rides on `--append-system-prompt` every turn (set
    // by the host from this field), so it survives `--resume` without polluting
    // the user-visible message. The chat bubble shows only the raw user text.
    const project = p.project ?? (await getProjectByThreadId(this.db, p.threadId));
    // Resolve the focused task only when it really belongs to this project —
    // a stale/cross-project taskId from the client must not leak into context.
    let task: ProjectTask | null = null;
    if (p.taskId) {
      const found = await getTask(this.db, p.taskId);
      if (found && (!project || found.projectId === project.id)) task = found;
    }
    const scope = project
      ? { projectId: project.id, projectName: project.name, task }
      : { task };
    const appendSystemPrompt = preamble(scope);

    const conn = this.hosts.getHostByIdForUser(p.userId, p.hostId);
    if (!conn) {
      await setRunnerSessionStatus(this.db, session.id, "failed");
      this.clients.sendToUser(p.userId, { t: "host-status", online: false });
      return;
    }
    try {
      conn.send({
        t: "dispatch",
        sessionId: session.id,
        threadId: p.threadId,
        adapter: ADAPTER,
        runnerSessionId: session.runnerSessionId,
        message: p.content,
        orchestrator: true,
        appendSystemPrompt,
      });
    } catch {
      await setRunnerSessionStatus(this.db, session.id, "failed");
      this.clients.sendToUser(p.userId, { t: "host-status", online: false });
    }
  }
}
