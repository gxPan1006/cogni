import type { RunnerEvent, SessionStatus } from "@cogni/contract";
import type { AnyDb } from "../db/users.js";
import { appendMessage, touchThread } from "../db/threads.js";
import {
  getOrCreateRunnerSession, getRunnerSessionById,
  setRunnerSessionId, setRunnerSessionStatus, appendEvent,
} from "../db/sessions.js";
import type { HostRouter } from "../host-router.js";
import type { ClientHub } from "../client-hub.js";

const ADAPTER = "claude-code"; // SP-1: chat domain always uses Claude Code

/**
 * Chat domain: one thread ↔ one long-lived runner session, interactive.
 * Owns the round trip: client message → persist → dispatch to host →
 * ingest streamed events → persist (events + assistant message) → fan-out.
 */
export class ChatDomain {
  /** sessionId → accumulated assistant text for the in-flight turn. */
  private accumulating = new Map<string, string>();

  constructor(
    private readonly db: AnyDb,
    private readonly hosts: HostRouter,
    private readonly clients: ClientHub,
  ) {}

  async handleClientSend(userId: string, threadId: string, text: string): Promise<void> {
    const userMsg = await appendMessage(this.db, { threadId, role: "user", content: text });
    await touchThread(this.db, threadId);
    this.clients.broadcast(threadId, {
      t: "message", threadId, messageId: userMsg.id, role: "user",
      content: userMsg.content, createdAt: userMsg.createdAt,
    });

    // SP-1: exactly one persistent RunnerSession per thread. It is reused across
    // every turn — `status` reflects the current/last turn, and `runnerSessionId`
    // carries across turns so the runner can --resume the same conversation.
    const session = await getOrCreateRunnerSession(this.db, threadId, ADAPTER);
    const host = this.hosts.getHostForUser(userId);
    if (!host) {
      this.clients.broadcast(threadId, { t: "host-status", online: false });
      return; // SP-1: message is persisted; user re-sends once a host is online
    }

    await setRunnerSessionStatus(this.db, session.id, "running");
    try {
      host.send({
        t: "dispatch",
        sessionId: session.id,
        threadId,
        adapter: ADAPTER,
        runnerSessionId: session.runnerSessionId,
        message: text,
      });
    } catch {
      // The host's socket failed — undo the running status and tell clients.
      await setRunnerSessionStatus(this.db, session.id, "failed");
      this.clients.broadcast(threadId, { t: "host-status", online: false });
    }
  }

  async handleHostEvent(sessionId: string, event: RunnerEvent): Promise<void> {
    const session = await getRunnerSessionById(this.db, sessionId);
    if (!session) return;
    const threadId = session.threadId;

    const stored = await appendEvent(this.db, { threadId, sessionId, event });

    // SP-1 doesn't special-case `permission-request` — it's persisted + fanned out
    // like any event, but there's no permission-prompt UI/flow until SP-3.
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
}
