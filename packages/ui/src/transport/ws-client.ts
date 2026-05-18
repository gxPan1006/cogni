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
 *   - List-channel frames (`thread-meta`, `thread-created`, `thread-deleted`,
 *     `device-list-changed`) are not delivered to thread subscribers; future
 *     list-level consumers can attach their own listener via
 *     `onUserFrame()` (not yet exposed — add when needed).
 */
import type { CloudToClient } from "@cogni/contract";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export interface ThreadSubscription {
  threadId: string;
  /** Read on every (re)subscribe so the cloud can catchup just the missed tail. */
  getLastSeq: () => number;
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
  /** Returns true iff the frame could be written to the socket synchronously. */
  send(threadId: string, text: string): boolean;
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
    // User-wide and unscoped frames — fan out to every active subscriber.
    if (
      frame.t === "host-status" ||
      frame.t === "host-meta" ||
      frame.t === "error"
    ) {
      for (const s of subs.values()) s.onFrame(frame);
      return;
    }
    // List-channel frames (thread-meta / thread-created / thread-deleted /
    // device-list-changed) are intentionally dropped here. List consumers can
    // be added later without disturbing thread subscribers.
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

    send(threadId, text) {
      return sendFrame({ t: "send", threadId, text });
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
      connectionListeners.clear();
      ws?.close();
      ws = null;
    },
  };
}
