import { useEffect, useRef, useState } from "react";
import type { MessageView, RunnerEvent, CloudToClient } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Subscribes to a thread's live event stream via WS. Caller passes an
 * ApiClient — the hook uses it both for the initial HTTP `getThread()` and
 * for `wsTokenQuery()` to attach the JWT to the WS URL.
 */
export function useThreadStream(api: ApiClient, threadId: string) {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<RunnerEvent[]>([]);
  const [hostOnline, setHostOnline] = useState(true);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setStreaming([]);
    setConnected(false);
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
        ws.send(JSON.stringify({ t: "subscribe", threadId }));
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
            // The cloud broadcasts the persisted assistant `message` BEFORE the
            // terminal `done` event, so clearing `streaming` here doesn't drop
            // the final reply.
            if (msg.event.type === "done" || msg.event.type === "error") setStreaming([]);
            else setStreaming((s) => [...s, msg.event]);
          } else if (msg.t === "host-status") {
            setHostOnline(msg.online);
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

  return { messages, streaming, hostOnline, connected, send };
}
