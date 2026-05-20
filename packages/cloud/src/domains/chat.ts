import type { RunnerEvent, SessionStatus } from "@cogni/contract";
import { randomUUID } from "node:crypto";
import { inArray, and, eq } from "drizzle-orm";
import type { AnyDb } from "../db/users.js";
import { appendMessage, touchThread, updateThreadTitle, getFirstTurnIfDefaultTitle } from "../db/threads.js";
import {
  getRunnerSessionById, setRunnerSessionId, setRunnerSessionStatus, appendEvent,
  getLatestSessionForThread, openRunnerSession, closeRunnerSession,
} from "../db/sessions.js";
import { hosts as hostsTable } from "../db/schema.js";
import type { HostRouter, ConnectedHost } from "../host-router.js";
import type { ClientHub } from "../client-hub.js";
import { logger } from "@cogni/shared";
import { sendHostRpc } from "../routes/host-ws.js";

const ADAPTER = "claude-code"; // SP-2: chat domain still always uses Claude Code

interface PendingFallback {
  userId: string;
  threadId: string;
  content: string;
  attachments?: Attachment[];
  model?: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

type Attachment = { name: string; size: number };

/**
 * Render an `AskUserQuestion` tool-call's `input.questions` payload into a
 * compact human-readable string for `project_tasks.needs_input_what`. The
 * runner's question shape (per superpowers tool: array of {question, header,
 * options[]}) is collapsed to the first question's text — the drawer's reply
 * box accepts free-form text, and one line is more useful than dumping the
 * whole multi-choice JSON. Falls back to a generic prompt if the shape is
 * unrecognized; we never throw — UX glitch beats lost lifecycle bridge.
 */
function formatAskUserQuestion(input: unknown): string {
  if (input && typeof input === "object" && "questions" in input) {
    const qs = (input as { questions?: unknown }).questions;
    if (Array.isArray(qs) && qs.length > 0) {
      const first = qs[0];
      if (first && typeof first === "object" && "question" in first) {
        const q = (first as { question?: unknown }).question;
        if (typeof q === "string" && q.trim().length > 0) return q.trim();
      }
    }
  }
  return "Runner needs your input to continue.";
}

/**
 * Prepend a short note pointing the agent at the files the user attached this
 * turn. They are materialized into the runner cwd under .cogni-uploads/ before
 * the turn runs, so a relative path is all the agent needs.
 */
function withAttachmentPreamble(content: string, attachments?: { name: string }[]): string {
  if (!attachments || attachments.length === 0) return content;
  const list = attachments.map((a) => `- ./.cogni-uploads/${a.name}`).join("\n");
  return `[用户上传了以下文件，位于当前工作目录的 ./.cogni-uploads/ 下：\n${list}]\n\n${content}`;
}

/**
 * Chat domain — SP-2 state machine.
 *
 * Send path: check host availability FIRST, then write message. Three outcomes:
 *   1. preferred host online (or new thread + any host online) → persist + dispatch
 *   2. preferred offline + alternatives available → host-fallback-prompt back
 *      to the sender; message NOT persisted yet; pending entry stored
 *   3. no hosts online at all → no-host-online back to sender; no persist
 *
 * Pre-dispatch state lives ONLY in client UI + this in-memory pending map.
 * Closing the app loses unresolved pendings — accepted V1 trade-off.
 *
 * Multi-host: each thread can have many runner_sessions across history.
 * "Preferred host" = host_id of the latest runner_session for the thread.
 * Switching to a new host closes the old session (status='closed') and opens
 * a new one; events keep growing on the same thread_id with monotonic seq.
 */
export class ChatDomain {
  /** sessionId → accumulated assistant text for the in-flight turn. */
  private accumulating = new Map<string, string>();
  private pendingFallbacks = new Map<string, PendingFallback>();

  /**
   * Optional hook for experiments that want AskUserQuestion to pause a task.
   * Production leaves this undefined: project runners should make reasonable
   * assumptions and keep moving instead of surfacing clarification prompts.
   */
  public onRunnerAskingForInput?: (threadId: string, questionText: string) => Promise<void>;

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
    attachments?: Attachment[];
    model?: string;
  }): Promise<void> {
    const { userId, threadId, content, sourceClientId, attachments, model } = input;
    const pendingMessageId = randomUUID();

    const latest = await getLatestSessionForThread(this.db, threadId);
    const preferredHostId = latest?.hostId ?? null;
    const onlineHosts = this.hosts.getOnlineHostsForUser(userId);

    if (onlineHosts.length === 0) {
      this.clients.sendToConn(sourceClientId, { t: "no-host-online", threadId, pendingMessageId });
      return;
    }

    // New thread (no preferred yet) → auto-pick most-recently-active online host.
    if (preferredHostId === null) {
      const chosen = onlineHosts[0];
      if (chosen) {
        await this.persistAndDispatch({ userId, threadId, content, hostId: chosen.hostId, attachments, model });
      }
      return;
    }

    // Preferred is online → reuse / new session on it.
    const preferredOnline = onlineHosts.find((h) => h.hostId === preferredHostId);
    if (preferredOnline) {
      await this.persistAndDispatch({ userId, threadId, content, hostId: preferredOnline.hostId, attachments, model });
      return;
    }

    // Preferred is offline but alternatives exist → emit fallback prompt.
    const alternatives = await this.describeOnlineHosts(onlineHosts);
    const preferredDesc = await this.describeHostById(userId, preferredHostId);
    this.clients.sendToConn(sourceClientId, {
      t: "host-fallback-prompt",
      threadId,
      pendingMessageId,
      preferred: preferredDesc,
      alternatives,
    });
    this.sweepPendings();
    this.pendingFallbacks.set(pendingMessageId, {
      userId, threadId, content, attachments, model, expiresAt: Date.now() + PENDING_TTL_MS,
    });
  }

  /**
   * Prewarm: the user opened a fresh chat / started composing. Spawn the
   * runner process on the target host ahead of the first `send`, so the first
   * token isn't gated on the ~1.9s CLI cold start. Best-effort and idempotent:
   *
   *  - No online host → silently no-op (the eventual send shows the
   *    no-host-online prompt as usual).
   *  - Reuses the thread's current session if one exists (same sessionId the
   *    later dispatch will reuse → the warm process is the one that gets used),
   *    otherwise opens one WITHOUT marking it `running` (no "thinking" UI).
   *  - Safe to call repeatedly (debounced keystrokes): `manager.prewarm` on the
   *    host is a no-op once a process exists for the session.
   */
  async handleClientPrewarm(input: { userId: string; threadId: string; model?: string }): Promise<void> {
    const { userId, threadId, model } = input;
    const onlineHosts = this.hosts.getOnlineHostsForUser(userId);
    if (onlineHosts.length === 0) return;

    const latest = await getLatestSessionForThread(this.db, threadId);
    // Pick the same host the send path would: the thread's current host if it's
    // online, else the most-recently-active online host (matches handleClientSend).
    const preferredOnline = latest?.hostId
      ? onlineHosts.find((h) => h.hostId === latest.hostId)
      : undefined;
    const hostId = preferredOnline?.hostId ?? onlineHosts[0]?.hostId;
    if (!hostId) return;

    const reusable = latest && latest.hostId === hostId && latest.status !== "closed";
    const session = reusable
      ? latest
      : await openRunnerSession(this.db, { threadId, hostId, adapter: ADAPTER });

    const conn = this.hosts.getHostByIdForUser(userId, hostId);
    if (!conn) return;
    try {
      conn.send({
        t: "prewarm",
        sessionId: session.id,
        threadId,
        adapter: ADAPTER,
        runnerSessionId: session.runnerSessionId,
        ...(model ? { model } : {}),
      });
    } catch {
      // best-effort; the real send will spawn lazily if this didn't land.
    }
  }

  async handleResolveFallback(input: {
    userId: string;
    pendingMessageId: string;
    action: "switch" | "cancel";
    targetHostId: string | null;
    sourceClientId: string;
  }): Promise<void> {
    this.sweepPendings();
    const pending = this.pendingFallbacks.get(input.pendingMessageId);
    if (!pending || pending.userId !== input.userId) return;
    this.pendingFallbacks.delete(input.pendingMessageId);

    if (input.action === "cancel") return;
    if (!input.targetHostId) return;

    const targetConn = this.hosts.getHostByIdForUser(input.userId, input.targetHostId);
    if (!targetConn) {
      this.clients.sendToConn(input.sourceClientId, {
        t: "no-host-online", threadId: pending.threadId, pendingMessageId: input.pendingMessageId,
      });
      return;
    }

    // Close the old session if any non-closed exists. Switching to a new host
    // means starting a fresh Claude Code session there (runner_session_id=null);
    // conversation history is rebuilt from messages.
    const latest = await getLatestSessionForThread(this.db, pending.threadId);
    if (latest && latest.status !== "closed") {
      await closeRunnerSession(this.db, latest.id);
    }
    await this.persistAndDispatch({
      userId: input.userId, threadId: pending.threadId, content: pending.content,
      hostId: input.targetHostId, attachments: pending.attachments, model: pending.model,
    });
  }

  async handleHostEvent(sessionId: string, event: RunnerEvent): Promise<void> {
    const session = await getRunnerSessionById(this.db, sessionId);
    if (!session) return;
    const threadId = session.threadId;

    const stored = await appendEvent(this.db, { threadId, sessionId, event });

    if (event.type === "session-id") {
      await setRunnerSessionId(this.db, sessionId, event.id);
    } else if (event.type === "tool-call" && event.name === "AskUserQuestion" && this.onRunnerAskingForInput) {
      // Optional needs-input bridge. Not wired in production; see field
      // comment above for the product rationale.
      void this.onRunnerAskingForInput(threadId, formatAskUserQuestion(event.input)).catch((err) => {
        // best-effort hook; surface the error but never abort event processing.
        // eslint-disable-next-line no-console
        console.warn("onRunnerAskingForInput hook threw:", err);
      });
    } else if (event.type === "text") {
      this.accumulating.set(sessionId, (this.accumulating.get(sessionId) ?? "") + event.text);
    } else if (event.type === "done") {
      const text = this.accumulating.get(sessionId) ?? "";
      this.accumulating.delete(sessionId);
      if (text.trim()) {
        const msg = await appendMessage(this.db, { threadId, role: "assistant", content: text });
        await touchThread(this.db, threadId);
        this.clients.broadcast(threadId, {
          t: "message", threadId, messageId: msg.id, role: "assistant",
          content: msg.content, createdAt: msg.createdAt,
        });
        // After the first assistant reply lands, fire-and-forget the
        // host-side titling RPC so "New chat" gets replaced in the sidebar.
        // Skipped if the host has gone offline or the thread already has a
        // non-default title (e.g. user renamed it manually, or we're past
        // the first round). See `getFirstTurnIfDefaultTitle` for the guard.
        if (session.hostId) {
          void this.maybeGenerateTitle({
            threadId,
            hostId: session.hostId,
            adapter: session.adapter,
            assistantReply: text,
          });
        }
      }
      await setRunnerSessionStatus(this.db, sessionId, "completed");
    } else if (event.type === "error") {
      this.accumulating.delete(sessionId);
      await setRunnerSessionStatus(this.db, sessionId, "failed");
    }

    this.clients.broadcast(threadId, { t: "event", threadId, seq: stored.seq, event });
  }

  async handleSessionUpdate(sessionId: string, status: SessionStatus): Promise<void> {
    await setRunnerSessionStatus(this.db, sessionId, status);
  }

  // --- private ---

  private async persistAndDispatch(p: {
    userId: string; threadId: string; content: string; hostId: string; attachments?: Attachment[]; model?: string;
  }): Promise<void> {
    const userMsg = await appendMessage(this.db, {
      threadId: p.threadId, role: "user", content: p.content, attachments: p.attachments,
    });
    await touchThread(this.db, p.threadId);
    this.clients.broadcast(p.threadId, {
      t: "message", threadId: p.threadId, messageId: userMsg.id, role: "user",
      content: userMsg.content, createdAt: userMsg.createdAt,
      ...(p.attachments && p.attachments.length > 0 ? { attachments: p.attachments } : {}),
    });

    // Reuse the same-host session across turns so Claude Code can --resume
    // its conversation context. Only open a new session when switching hosts
    // (latest.hostId !== p.hostId) OR the session was explicitly closed
    // (status='closed', set by resolve-fallback's switch path).
    const latest = await getLatestSessionForThread(this.db, p.threadId);
    const reusable = latest && latest.hostId === p.hostId && latest.status !== "closed";
    const session = reusable
      ? latest
      : await openRunnerSession(this.db, { threadId: p.threadId, hostId: p.hostId, adapter: ADAPTER });

    await setRunnerSessionStatus(this.db, session.id, "running");

    // Host may have dropped between the online-check and now. Mark failed if
    // dispatch can't reach it.
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
        message: withAttachmentPreamble(p.content, p.attachments),
        ...(p.attachments && p.attachments.length > 0 ? { attachments: p.attachments } : {}),
        ...(p.model ? { model: p.model } : {}),
      });
    } catch {
      await setRunnerSessionStatus(this.db, session.id, "failed");
      this.clients.sendToUser(p.userId, { t: "host-status", online: false });
    }
  }

  /**
   * Fire-and-forget thread auto-titling. Triggered after the first
   * assistant reply on a thread whose title is still "New chat".
   *
   * Why fire-and-forget: titling adds 1-3s of CLI latency and must not
   * block the `done` event broadcast — the user is already looking at
   * the assistant's reply by then; the sidebar title catching up a beat
   * later is fine. Errors are logged and swallowed (title stays default).
   *
   * Idempotency: `getFirstTurnIfDefaultTitle` re-checks the precondition
   * inside the same tick the RPC fires; if a parallel done event slipped
   * through (shouldn't, since chat is single-turn but defensive), the
   * second invocation bails on the message-count mismatch.
   */
  private async maybeGenerateTitle(p: {
    threadId: string; hostId: string; adapter: string; assistantReply: string;
  }): Promise<void> {
    try {
      const precond = await getFirstTurnIfDefaultTitle(this.db, p.threadId);
      if (!precond) return;
      const resp = await sendHostRpc(
        p.hostId,
        {
          method: "generate-thread-title",
          params: {
            adapter: p.adapter,
            userMessage: precond.firstUserMessage,
            assistantReply: p.assistantReply,
          },
        },
        { timeoutMs: 30_000 },
      );
      if (!resp.ok || resp.method !== "generate-thread-title") {
        logger.warn({ threadId: p.threadId, resp }, "generate-thread-title rpc failed");
        return;
      }
      const updated = await updateThreadTitle(this.db, p.threadId, resp.result.title);
      if (!updated) return;
      this.clients.publishThreadMeta(updated.userId, {
        threadId: p.threadId,
        title: updated.title,
        lastMsgAt: updated.updatedAt,
      });
    } catch (err) {
      logger.warn({ threadId: p.threadId, err: String(err) }, "auto-title failed");
    }
  }

  private sweepPendings(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingFallbacks) if (v.expiresAt < now) this.pendingFallbacks.delete(k);
  }

  /** Bulk-resolve name + lastSeenAgoMs for a set of online hosts. */
  private async describeOnlineHosts(
    online: ConnectedHost[],
  ): Promise<Array<{ id: string; name: string; lastSeenAgoMs: number }>> {
    if (online.length === 0) return [];
    const ids = online.map((h) => h.hostId);
    const rows = await this.db.select().from(hostsTable).where(inArray(hostsTable.id, ids));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      lastSeenAgoMs: r.lastSeen ? Date.now() - r.lastSeen.getTime() : 0,
    }));
  }

  private async describeHostById(
    userId: string, hostId: string,
  ): Promise<{ id: string; name: string; lastSeenAgoMs: number }> {
    const rows = await this.db.select().from(hostsTable)
      .where(and(eq(hostsTable.userId, userId), eq(hostsTable.id, hostId))).limit(1);
    if (!rows[0]) return { id: hostId, name: "Unknown", lastSeenAgoMs: 0 };
    return {
      id: rows[0].id, name: rows[0].name,
      lastSeenAgoMs: rows[0].lastSeen ? Date.now() - rows[0].lastSeen.getTime() : 0,
    };
  }
}
