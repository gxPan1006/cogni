import { useEffect, useRef, useState } from "react";
import type { MessageView, RunnerEvent, CloudToClient } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

type PendingFallback = {
  pendingMessageId: string;
  preferred: { id: string; name: string; lastSeenAgoMs: number };
  alternatives: Array<{ id: string; name: string; lastSeenAgoMs: number }>;
};
type PendingNoHost = { pendingMessageId: string };

/**
 * Subscribes to a thread's live event stream via WS. Caller passes an
 * ApiClient — the hook uses it both for the initial HTTP `getThread()` and
 * for `wsTokenQuery()` to attach the JWT to the WS URL.
 *
 * SP-2 additions:
 *  - Uses `subscribe-thread { lastSeq }` so the cloud can replay events the
 *    client missed during disconnect (catchup). `lastSeqRef` survives
 *    reconnects across the lifetime of this hook instance.
 *  - On `catchup-too-long`, falls back to HTTP-pulling the full thread to
 *    rebuild local state from scratch.
 *  - Tracks multi-host UX state: `pendingFallback` (preferred host offline,
 *    cloud is asking the user which alternative to use), `pendingNoHost`
 *    (zero hosts online — composer can't dispatch anywhere). Resolved via
 *    `resolveFallback(action, targetHostId?)` (sends `resolve-fallback`) and
 *    `dismissNoHost()` (UI-only — server has no state to clear).
 *  - `host-meta` updates `hostOnline` whenever the cloud sends fresh status
 *    for this thread's host.
 */
export function useThreadStream(api: ApiClient, threadId: string) {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<RunnerEvent[]>([]);
  const [hostOnline, setHostOnline] = useState(true);
  const [connected, setConnected] = useState(false);
  const [pendingFallback, setPendingFallback] = useState<PendingFallback | null>(null);
  const [pendingNoHost, setPendingNoHost] = useState<PendingNoHost | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // `lastSeqRef` survives reconnects so subscribe-thread can ask the cloud to
  // replay only the events the client missed. Reset to 0 on threadId change.
  const lastSeqRef = useRef<number>(0);

  useEffect(() => {
    setStreaming([]);
    setConnected(false);
    setPendingFallback(null);
    setPendingNoHost(null);
    lastSeqRef.current = 0;
    api
      .getThread(threadId)
      .then((d) => setMessages(d.messages ?? []))
      .catch((e) => {
        console.error("failed to load thread history", e);
        setMessages([]);
      });

    let closed = false; // set by cleanup — stops the reconnect loop
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(`${api.wsUrl}/api/ws${api.wsTokenQuery()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (ws.readyState !== WebSocket.OPEN) return; // a stale socket whose handshake landed after cleanup
        attempt = 0;
        setConnected(true);
        ws.send(
          JSON.stringify({
            t: "subscribe-thread",
            threadId,
            lastSeq: lastSeqRef.current,
          }),
        );
      };

      ws.onmessage = (e) => {
        let msg: CloudToClient;
        try {
          msg = JSON.parse(e.data) as CloudToClient;
        } catch {
          return; // malformed frame — ignore
        }
        try {
          if (msg.t === "message") {
            setMessages((m) => [
              ...m,
              {
                id: msg.messageId,
                threadId: msg.threadId,
                role: msg.role,
                content: msg.content,
                createdAt: msg.createdAt,
              },
            ]);
          } else if (msg.t === "event") {
            if (msg.seq > lastSeqRef.current) lastSeqRef.current = msg.seq;
            // The cloud broadcasts the persisted assistant `message` BEFORE the
            // terminal `done` event, so clearing `streaming` here doesn't drop
            // the final reply.
            if (msg.event.type === "done" || msg.event.type === "error") setStreaming([]);
            else setStreaming((s) => [...s, msg.event]);
          } else if (msg.t === "host-status") {
            setHostOnline(msg.online);
          } else if (msg.t === "host-meta") {
            // Per-thread host status push from the cloud. We don't distinguish
            // hostId here — the cloud only sends `host-meta` for hosts that
            // the current subscription cares about, so any update is signal
            // about *this* thread's effective host.
            setHostOnline(msg.status === "online");
          } else if (msg.t === "catchup-complete") {
            if (msg.latestSeq > lastSeqRef.current) lastSeqRef.current = msg.latestSeq;
          } else if (msg.t === "catchup-too-long") {
            // Too many missed events to replay — refetch full thread state.
            const targetSeq = msg.latestSeq;
            void api
              .getThread(threadId)
              .then((d) => {
                setMessages(d.messages ?? []);
                lastSeqRef.current = targetSeq;
              })
              .catch((err) => console.error("catchup-too-long: getThread failed", err));
          } else if (msg.t === "host-fallback-prompt") {
            setPendingFallback({
              pendingMessageId: msg.pendingMessageId,
              preferred: msg.preferred,
              alternatives: msg.alternatives,
            });
          } else if (msg.t === "no-host-online") {
            setPendingNoHost({ pendingMessageId: msg.pendingMessageId });
          } else if (msg.t === "error") {
            console.warn("cloud error frame", msg.message);
          }
        } catch (err) {
          console.warn("ws message handling failed", err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // `onclose` always follows `onerror` — reconnect is handled there.
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [api, threadId]);

  const send = (text: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "send", threadId, text }));
      return true;
    }
    console.warn("cannot send — websocket not open");
    return false;
  };

  const resolveFallback = (action: "switch" | "cancel", targetHostId?: string) => {
    const id = pendingFallback?.pendingMessageId;
    if (!id) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          t: "resolve-fallback",
          pendingMessageId: id,
          action,
          targetHostId,
        }),
      );
    } else {
      console.warn("cannot resolve-fallback — websocket not open");
    }
    setPendingFallback(null);
  };

  const dismissNoHost = () => setPendingNoHost(null);

  return {
    messages,
    streaming,
    hostOnline,
    connected,
    send,
    pendingFallback,
    pendingNoHost,
    resolveFallback,
    dismissNoHost,
  };
}
