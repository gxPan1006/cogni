import type { RunnerEvent, SessionStatus } from "@cogni/contract";
import { randomUUID } from "node:crypto";
import { inArray, and, eq } from "drizzle-orm";
import type { AnyDb } from "../db/users.js";
import { appendMessage, touchThread } from "../db/threads.js";
import {
  getRunnerSessionById, setRunnerSessionId, setRunnerSessionStatus, appendEvent,
  getLatestSessionForThread, openRunnerSession, closeRunnerSession,
} from "../db/sessions.js";
import { hosts as hostsTable } from "../db/schema.js";
import type { HostRouter, ConnectedHost } from "../host-router.js";
import type { ClientHub } from "../client-hub.js";

const ADAPTER = "claude-code"; // SP-2: chat domain still always uses Claude Code

interface PendingFallback {
  userId: string;
  threadId: string;
  content: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

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
  }): Promise<void> {
    const { userId, threadId, content, sourceClientId } = input;
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
        await this.persistAndDispatch({ userId, threadId, content, hostId: chosen.hostId });
      }
      return;
    }

    // Preferred is online → reuse / new session on it.
    const preferredOnline = onlineHosts.find((h) => h.hostId === preferredHostId);
    if (preferredOnline) {
      await this.persistAndDispatch({ userId, threadId, content, hostId: preferredOnline.hostId });
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
      userId, threadId, content, expiresAt: Date.now() + PENDING_TTL_MS,
    });
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
      hostId: input.targetHostId,
    });
  }

  async handleHostEvent(sessionId: string, event: RunnerEvent): Promise<void> {
    const session = await getRunnerSessionById(this.db, sessionId);
    if (!session) return;
    const threadId = session.threadId;

    const stored = await appendEvent(this.db, { threadId, sessionId, event });

    if (event.type === "session-id") {
      await setRunnerSessionId(this.db, sessionId, event.id);
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
    userId: string; threadId: string; content: string; hostId: string;
  }): Promise<void> {
    const userMsg = await appendMessage(this.db, {
      threadId: p.threadId, role: "user", content: p.content,
    });
    await touchThread(this.db, p.threadId);
    this.clients.broadcast(p.threadId, {
      t: "message", threadId: p.threadId, messageId: userMsg.id, role: "user",
      content: userMsg.content, createdAt: userMsg.createdAt,
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
        message: p.content,
      });
    } catch {
      await setRunnerSessionStatus(this.db, session.id, "failed");
      this.clients.sendToUser(p.userId, { t: "host-status", online: false });
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
