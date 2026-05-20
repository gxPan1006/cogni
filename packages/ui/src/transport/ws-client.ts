/**
 * Long-lived, multiplexed WebSocket client for the cloud's `/api/ws` endpoint.
 *
 * Why this exists: the cloud's WS is per-user (auth at handshake) and supports
 * many concurrent thread subscriptions on one connection via
 * `subscribe-thread` / `unsubscribe-thread` frames. Earlier the UI opened a
 * fresh WS for every thread the user looked at, which made the connection
 * status flip to "disconnected" every time the user clicked a different chat
 * in the sidebar. This module owns one connection per ApiClient instance and
 * lets per-thread hooks subscribe / unsubscribe cheaply.
 *
 * Lifecycle:
 *   - The first `subscribeThread()` triggers `connect()` (lazy).
 *   - On `ws.onopen`, every active subscription is (re)sent with its latest
 *     known `lastSeq`, so a reconnect transparently catches up.
 *   - `ws.onclose` schedules an exponential-backoff reconnect (1s → 15s cap),
 *     toggles `connected = false`, and notifies listeners. Switching threads
 *     does NOT touch the WS — only frames are emitted.
 *
 * Frame routing:
 *   - `event` / `message` / `catchup-complete` / `catchup-too-long`
 *     / `host-fallback-prompt` / `no-host-online` carry `threadId` and go to
 *     that thread's subscriber only.
 *   - `host-status` (user-wide) and `host-meta` (user-wide) fan out to every
 *     active subscription — each hook interprets them locally.
 *   - `error` fans out (every hook can choose to log).
 *   - SP-3 list-level frames (`project-event`) fan out to every active
 *     `subscribe-projects` listener; per-project frames (`task-event` for a
 *     particular projectId) fan out to every `subscribe-project` listener
 *     for that projectId. Per-task subscribers see the same `task-event`
 *     frames filtered by their taskId. The cloud is responsible for only
 *     pushing frames the subscribing user is entitled to see; routing here
 *     is purely a client-side fan-out optimization.
 *   - Remaining list-channel frames (`thread-meta`, `thread-created`,
 *     `thread-deleted`, `device-list-changed`) are not delivered to thread
 *     subscribers; future list-level consumers can attach their own
 *     listener via `onUserFrame()` (not yet exposed — add when needed).
 */
import type { CloudToClient } from "@cogni/contract";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
// Heartbeat: ping cadence is well under typical NAT / proxy idle cutoffs so the
// socket — and the tunnel it rides — never goes cold (a cold tunnel makes the
// first frame after a pause ~2x slower). If no `pong` comes back within the
// timeout the socket is silently dead; we force a reconnect instead of letting
// the next user action stall on it.
const HEARTBEAT_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

export interface ThreadSubscription {
  threadId: string;
  /** Read on every (re)subscribe so the cloud can catchup just the missed tail. */
  getLastSeq: () => number;
  onFrame: (frame: CloudToClient) => void;
}

/**
 * SP-2 thread-list subscriber. The cloud's `subscribe-list` channel pushes
 * `thread-meta` (auto-title updates), `thread-created`, and `thread-deleted`
 * — all the events the sidebar needs to keep its left-rail list in sync
 * without polling `/api/threads` after every turn.
 */
export interface ListSubscription {
  onFrame: (frame: CloudToClient) => void;
}

/**
 * SP-3 list-level subscriber (the user's whole project list). One frame
 * `project-event` per change; the hook's reducer applies created / updated /
 * archived locally.
 */
export interface ProjectsSubscription {
  onFrame: (frame: CloudToClient) => void;
}

/**
 * SP-3 per-project subscriber. Receives `task-event` frames whose `task.projectId`
 * matches `projectId`, plus any user-wide frames (host-status etc).
 */
export interface ProjectSubscription {
  projectId: string;
  onFrame: (frame: CloudToClient) => void;
}

/**
 * SP-3 per-task subscriber. Receives `task-event` frames whose `task.id`
 * matches `taskId`. The hook layer is responsible for separately subscribing
 * to the task's `executionThreadId` for the runner event stream (which still
 * flows on the existing `event` channel via `subscribeThread`).
 */
export interface TaskSubscription {
  taskId: string;
  onFrame: (frame: CloudToClient) => void;
}

export interface WsClient {
  /** Current connection state. */
  isConnected(): boolean;
  /** Notified on every transition. Returns an unsubscribe function. */
  onConnectionChange(cb: (connected: boolean) => void): () => void;
  /**
   * Attach a thread subscriber. Sends `subscribe-thread` immediately if the
   * WS is open; otherwise queues it for the next `onopen`. Returns an
   * unsubscribe function that emits `unsubscribe-thread` and detaches.
   */
  subscribeThread(sub: ThreadSubscription): () => void;
  /**
   * Attach a projects-list subscriber. Sends `subscribe-projects` immediately
   * if the WS is open; otherwise queues it for the next `onopen`. The cloud
   * deduplicates multiple `subscribe-projects` frames per session (idempotent),
   * but we still echo `unsubscribe-projects` when the last local listener
   * detaches so reconnect doesn't carry over stale interest.
   */
  subscribeProjects(sub: ProjectsSubscription): () => void;
  /** Attach a per-project subscriber. Emits `subscribe-project` once per projectId. */
  subscribeProject(sub: ProjectSubscription): () => void;
  /** Attach a per-task subscriber. Emits `subscribe-task` once per taskId. */
  subscribeTask(sub: TaskSubscription): () => void;
  /** Attach a thread-list subscriber. Emits `subscribe-list` exactly once when
   *  the first local listener attaches, and `unsubscribe-list` only when the
   *  last one detaches. The single sidebar mount is the expected caller. */
  subscribeList(sub: ListSubscription): () => void;
  /** Returns true iff the frame could be written to the socket synchronously. */
  send(threadId: string, text: string, attachments?: { name: string; size: number }[], taskId?: string, model?: string): boolean;
  /**
   * Hint that the user opened/started composing on this thread, so the cloud
   * can spawn the runner process ahead of the first `send` (hides the CLI cold
   * start). Best-effort + idempotent on the cloud — safe to call (debounced) on
   * composer focus / first keystroke.
   */
  prewarm(threadId: string, model?: string): boolean;
  resolveFallback(
    pendingMessageId: string,
    action: "switch" | "cancel",
    targetHostId?: string,
  ): boolean;
  /** Closes the connection permanently and stops the reconnect loop. */
  close(): void;
}

/**
 * `buildUrl` is invoked on every (re)connect so token rotation is picked up.
 * Typically: `() => `${api.wsUrl}/api/ws${api.wsTokenQuery()}``.
 */
export function createWsClient(buildUrl: () => string): WsClient {
  let ws: WebSocket | null = null;
  let connected = false;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const subs = new Map<string, ThreadSubscription>();
  // SP-3 fan-out sets (parallel to thread `subs`; not keyed because list /
  // per-project / per-task subscriptions naturally support multiple
  // simultaneous mounts of the same scope — e.g. Sidebar + ProjectsList both
  // listen to the projects channel — and we want every mount to receive every
  // matching frame).
  const projectsSubs = new Set<ProjectsSubscription>();
  const projectSubs = new Set<ProjectSubscription>();
  const taskSubs = new Set<TaskSubscription>();
  const listSubs = new Set<ListSubscription>();
  // Per-scope refcount so we send `subscribe-X` exactly once on open and
  // `unsubscribe-X` only when the last listener detaches. Keyed by the
  // scope's stable identifier ("__list__" for the list channel, or the
  // projectId / taskId for per-scope channels).
  const projectRefcount = new Map<string, number>();
  const taskRefcount = new Map<string, number>();
  let projectsRefcount = 0;
  let listRefcount = 0;
  const connectionListeners = new Set<(c: boolean) => void>();

  function setConnected(next: boolean) {
    if (connected === next) return;
    connected = next;
    for (const cb of connectionListeners) {
      try { cb(next); } catch { /* listener bugs shouldn't break others */ }
    }
  }

  function sendFrame(frame: object): boolean {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  function dispatch(frame: CloudToClient) {
    // Per-thread frames carry threadId — route to that single subscriber.
    if (
      frame.t === "event" ||
      frame.t === "message" ||
      frame.t === "catchup-complete" ||
      frame.t === "catchup-too-long" ||
      frame.t === "host-fallback-prompt" ||
      frame.t === "no-host-online"
    ) {
      subs.get(frame.threadId)?.onFrame(frame);
      return;
    }
    // User-wide and unscoped frames — fan out to every active subscriber
    // (thread, projects-list, per-project, per-task, AND list).
    if (
      frame.t === "host-status" ||
      frame.t === "host-meta" ||
      frame.t === "error"
    ) {
      for (const s of subs.values()) s.onFrame(frame);
      for (const s of projectsSubs) s.onFrame(frame);
      for (const s of projectSubs) s.onFrame(frame);
      for (const s of taskSubs) s.onFrame(frame);
      // The web Shell tracks host online/offline via subscribeList (its only
      // subscription when sitting on the chat or projects-list page — no
      // thread/project sub of its own). host-status / host-meta are user-wide
      // signals the sidebar host count depends on, so list subscribers must
      // see them too. (thread-meta / thread-* below stay list-only.)
      for (const s of listSubs) s.onFrame(frame);
      return;
    }
    // SP-3 project-list frames. Cloud filters by user; every list listener
    // for this user gets it.
    if (frame.t === "project-event") {
      for (const s of projectsSubs) s.onFrame(frame);
      return;
    }
    // SP-3 task frames. Two scopes:
    //   - Per-project subscribers see every task-event whose `task.projectId`
    //     matches (so the board reflects new/updated/deleted cards live).
    //   - Per-task subscribers see only their own `task.id` (the drawer).
    if (frame.t === "task-event") {
      for (const s of projectSubs) {
        if (s.projectId === frame.task.projectId) s.onFrame(frame);
      }
      for (const s of taskSubs) {
        if (s.taskId === frame.task.id) s.onFrame(frame);
      }
      return;
    }
    // SP-2 list-channel frames. Sidebar (and any future list-aware mount)
    // attaches via `subscribeList`; the cloud only pushes these to clients
    // that sent `subscribe-list`, so the fan-out here is unconditional.
    if (
      frame.t === "thread-meta" ||
      frame.t === "thread-created" ||
      frame.t === "thread-deleted" ||
      frame.t === "device-list-changed"
    ) {
      for (const s of listSubs) s.onFrame(frame);
      return;
    }
  }

  function connect() {
    if (closed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const next = new WebSocket(buildUrl());
    ws = next;

    next.onopen = () => {
      if (next !== ws) return; // a stale socket whose open landed after teardown
      attempt = 0;
      setConnected(true);
      for (const s of subs.values()) {
        sendFrame({ t: "subscribe-thread", threadId: s.threadId, lastSeq: s.getLastSeq() });
      }
      // SP-2 list channel — resubscribe if any listener attached before
      // (re)connect. Cloud's subscribeList is idempotent per clientId, but
      // we still gate on the refcount to avoid noise.
      if (listRefcount > 0) sendFrame({ t: "subscribe-list" });
      // SP-3 channels — resubscribe each scope exactly once even if multiple
      // local listeners share it (the refcount maps drive this).
      if (projectsRefcount > 0) sendFrame({ t: "subscribe-projects" });
      for (const projectId of projectRefcount.keys()) {
        sendFrame({ t: "subscribe-project", projectId });
      }
      for (const taskId of taskRefcount.keys()) {
        sendFrame({ t: "subscribe-task", taskId });
      }
    };

    next.onmessage = (e) => {
      let msg: CloudToClient;
      try {
        msg = JSON.parse(e.data) as CloudToClient;
      } catch {
        return; // malformed — ignore
      }
      try {
        dispatch(msg);
      } catch (err) {
        console.warn("ws dispatch failed", err);
      }
    };

    next.onclose = () => {
      if (next !== ws) return;
      ws = null;
      setConnected(false);
      if (closed) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };

    next.onerror = () => {
      // `onclose` always follows `onerror` — reconnect is handled there.
    };
  }

  return {
    isConnected: () => connected,

    onConnectionChange(cb) {
      connectionListeners.add(cb);
      return () => connectionListeners.delete(cb);
    },

    subscribeThread(sub) {
      subs.set(sub.threadId, sub);
      if (!ws) connect();
      else sendFrame({ t: "subscribe-thread", threadId: sub.threadId, lastSeq: sub.getLastSeq() });
      return () => {
        if (subs.get(sub.threadId) === sub) {
          subs.delete(sub.threadId);
          sendFrame({ t: "unsubscribe-thread", threadId: sub.threadId });
        }
      };
    },

    subscribeProjects(sub) {
      projectsSubs.add(sub);
      const wasZero = projectsRefcount === 0;
      projectsRefcount += 1;
      if (!ws) connect();
      else if (wasZero) sendFrame({ t: "subscribe-projects" });
      return () => {
        if (!projectsSubs.delete(sub)) return;
        projectsRefcount = Math.max(0, projectsRefcount - 1);
        if (projectsRefcount === 0) sendFrame({ t: "unsubscribe-projects" });
      };
    },

    subscribeProject(sub) {
      projectSubs.add(sub);
      const prev = projectRefcount.get(sub.projectId) ?? 0;
      projectRefcount.set(sub.projectId, prev + 1);
      if (!ws) connect();
      else if (prev === 0) sendFrame({ t: "subscribe-project", projectId: sub.projectId });
      return () => {
        if (!projectSubs.delete(sub)) return;
        const remaining = (projectRefcount.get(sub.projectId) ?? 1) - 1;
        if (remaining <= 0) {
          projectRefcount.delete(sub.projectId);
          sendFrame({ t: "unsubscribe-project", projectId: sub.projectId });
        } else {
          projectRefcount.set(sub.projectId, remaining);
        }
      };
    },

    subscribeTask(sub) {
      taskSubs.add(sub);
      const prev = taskRefcount.get(sub.taskId) ?? 0;
      taskRefcount.set(sub.taskId, prev + 1);
      if (!ws) connect();
      else if (prev === 0) sendFrame({ t: "subscribe-task", taskId: sub.taskId });
      return () => {
        if (!taskSubs.delete(sub)) return;
        const remaining = (taskRefcount.get(sub.taskId) ?? 1) - 1;
        if (remaining <= 0) {
          taskRefcount.delete(sub.taskId);
          sendFrame({ t: "unsubscribe-task", taskId: sub.taskId });
        } else {
          taskRefcount.set(sub.taskId, remaining);
        }
      };
    },

    subscribeList(sub) {
      listSubs.add(sub);
      const wasZero = listRefcount === 0;
      listRefcount += 1;
      if (!ws) connect();
      else if (wasZero) sendFrame({ t: "subscribe-list" });
      // Cloud has no `unsubscribe-list` frame — the list channel is cheap
      // and ClientHub.unregister cleans up on disconnect. We still drop the
      // local listener so its callback stops firing after teardown.
      return () => {
        if (!listSubs.delete(sub)) return;
        listRefcount = Math.max(0, listRefcount - 1);
      };
    },

    send(threadId, text, attachments, taskId, model) {
      return sendFrame({
        t: "send",
        threadId,
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(taskId ? { taskId } : {}),
        ...(model ? { model } : {}),
      });
    },

    prewarm(threadId, model) {
      return sendFrame({ t: "prewarm", threadId, ...(model ? { model } : {}) });
    },

    resolveFallback(pendingMessageId, action, targetHostId) {
      return sendFrame({
        t: "resolve-fallback",
        pendingMessageId,
        action,
        targetHostId,
      });
    },

    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      subs.clear();
      projectsSubs.clear();
      projectSubs.clear();
      taskSubs.clear();
      listSubs.clear();
      projectRefcount.clear();
      taskRefcount.clear();
      projectsRefcount = 0;
      listRefcount = 0;
      connectionListeners.clear();
      ws?.close();
      ws = null;
    },
  };
}
