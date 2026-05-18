import { useEffect, useRef, useState } from "react";
import type { MessageView, RunnerEvent, CloudToClient } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";

type PendingFallback = {
  pendingMessageId: string;
  preferred: { id: string; name: string; lastSeenAgoMs: number };
  alternatives: Array<{ id: string; name: string; lastSeenAgoMs: number }>;
};
type PendingNoHost = { pendingMessageId: string };

/**
 * Subscribes to one thread's live event stream over the ApiClient's shared
 * WebSocket (`api.wsClient`).
 *
 * Lifecycle is split deliberately:
 *
 *   - **Connection state** (`connected`) follows the shared WS for the whole
 *     ApiClient — switching threads does NOT toggle it. The red "重连中"
 *     pill only appears when the underlying socket really drops.
 *   - **Subscription** (`subscribe-thread { lastSeq } / unsubscribe-thread`)
 *     is per-thread and per-mount. Each `threadId` change tears down the old
 *     subscription and opens a new one over the same WS.
 *
 * SP-2 features still owned here:
 *   - `lastSeqRef` survives reconnects so `subscribe-thread { lastSeq }` can
 *     ask the cloud to replay only the events the client missed.
 *   - On `catchup-too-long`, falls back to HTTP `getThread()` to rebuild
 *     local state.
 *   - Multi-host UX: `pendingFallback` and `pendingNoHost` are populated from
 *     `host-fallback-prompt` / `no-host-online` frames (now routed by
 *     `threadId` so other threads' responses don't bleed into this hook),
 *     resolved via `resolveFallback` and `dismissNoHost`.
 *   - `host-meta` / `host-status` update `hostOnline` whenever the cloud
 *     pushes fresh status.
 */
export function useThreadStream(api: ApiClient, threadId: string) {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<RunnerEvent[]>([]);
  const [hostOnline, setHostOnline] = useState(true);
  const [connected, setConnected] = useState(() => api.wsClient.isConnected());
  const [pendingFallback, setPendingFallback] = useState<PendingFallback | null>(null);
  const [pendingNoHost, setPendingNoHost] = useState<PendingNoHost | null>(null);
  // Survives subscribe/unsubscribe and (re)connects for this hook instance.
  // Reset to 0 only when the threadId changes.
  const lastSeqRef = useRef<number>(0);

  // Bind `connected` to the shared connection — independent of threadId so
  // switching threads doesn't flap the pill.
  useEffect(() => {
    const ws = api.wsClient;
    setConnected(ws.isConnected());
    return ws.onConnectionChange(setConnected);
  }, [api]);

  // Subscription lifecycle — owns thread-scoped state.
  useEffect(() => {
    setStreaming([]);
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

    const unsubscribe = api.wsClient.subscribeThread({
      threadId,
      getLastSeq: () => lastSeqRef.current,
      onFrame: (msg: CloudToClient) => {
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
            // Per-user host status push. The hook can't tell whether the host
            // is *this* thread's effective host (we don't track that yet), so
            // we treat any update as signal — same approximation as before.
            setHostOnline(msg.status === "online");
          } else if (msg.t === "catchup-complete") {
            if (msg.latestSeq > lastSeqRef.current) lastSeqRef.current = msg.latestSeq;
          } else if (msg.t === "catchup-too-long") {
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
          console.warn("ws frame handling failed", err);
        }
      },
    });

    return unsubscribe;
  }, [api, threadId]);

  const send = (text: string) => api.wsClient.send(threadId, text);

  const resolveFallback = (action: "switch" | "cancel", targetHostId?: string) => {
    const id = pendingFallback?.pendingMessageId;
    if (!id) return;
    api.wsClient.resolveFallback(id, action, targetHostId);
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
