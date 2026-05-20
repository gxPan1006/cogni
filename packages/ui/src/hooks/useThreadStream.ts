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
  // The thread's full event stream, in seq order. Seeded by the cloud's
  // subscribe catchup (it replays every persisted event) and appended to as
  // live frames arrive. Crucially this is NOT cleared on `done` — completed
  // turns keep their events so tool-call pills survive past the final answer
  // and across reloads. `buildTimeline` slices it back into per-turn blocks.
  const [events, setEvents] = useState<RunnerEvent[]>([]);
  const [hostOnline, setHostOnline] = useState(true);
  const [connected, setConnected] = useState(() => api.wsClient.isConnected());
  const [pendingFallback, setPendingFallback] = useState<PendingFallback | null>(null);
  const [pendingNoHost, setPendingNoHost] = useState<PendingNoHost | null>(null);
  // Survives subscribe/unsubscribe and (re)connects for this hook instance.
  // Reset to 0 only when the threadId changes.
  const lastSeqRef = useRef<number>(0);
  // The initial catchup replay is buffered and flushed in a single batch on
  // `catchup-complete` (see effect). Without this, switching into a thread
  // paints the text first and then lets tool-call pills pop in one event at a
  // time as the replay frames arrive — the "loading flash" on session switch.
  const caughtUpRef = useRef(false);
  const replayBufferRef = useRef<RunnerEvent[]>([]);

  // Bind `connected` to the shared connection — independent of threadId so
  // switching threads doesn't flap the pill.
  useEffect(() => {
    const ws = api.wsClient;
    setConnected(ws.isConnected());
    return ws.onConnectionChange(setConnected);
  }, [api]);

  // Subscription lifecycle — owns thread-scoped state.
  useEffect(() => {
    setPendingFallback(null);
    setPendingNoHost(null);
    caughtUpRef.current = false;
    replayBufferRef.current = [];

    // SWR seed: render the last-seen messages AND event stream for THIS thread
    // synchronously, so switching back to an already-seen thread paints the full
    // conversation — prose *and* tool-call pills — in one frame, with no
    // text-first-then-pills flash. When there's no cache, clear to [] so we
    // never leave the previous thread's view on screen during the round-trip.
    // lastSeqRef is seeded from the cached tail so the subscribe only replays
    // the events we haven't seen.
    const cacheKey = `thread:${threadId}`;
    const evCacheKey = `events:${threadId}`;
    const cached = api.cache.get<MessageView[]>(cacheKey);
    const cachedEv = api.cache.get<{ events: RunnerEvent[]; lastSeq: number }>(evCacheKey);
    setMessages(cached ?? []);
    setEvents(cachedEv?.events ?? []);
    lastSeqRef.current = cachedEv?.lastSeq ?? 0;

    // Guards a stale getThread/catchup resolving after the user already moved
    // on — without this the late promise would clobber the new thread's view.
    let active = true;
    const commitMessages = (msgs: MessageView[]) => {
      api.cache.set(cacheKey, msgs);
      if (active) setMessages(msgs);
    };

    // Flush the buffered catchup replay in one batch (idempotent). Called on
    // catchup-complete / catchup-too-long so the freshly-loaded history appears
    // in a single render and live events that follow append directly.
    const flushReplay = () => {
      if (caughtUpRef.current) return;
      caughtUpRef.current = true;
      const buffered = replayBufferRef.current;
      replayBufferRef.current = [];
      if (buffered.length === 0 || !active) return;
      setEvents((s) => {
        const next = [...s, ...buffered];
        api.cache.set(evCacheKey, { events: next, lastSeq: lastSeqRef.current });
        return next;
      });
    };

    api
      .getThread(threadId)
      .then((d) => commitMessages(d.messages ?? []))
      .catch((e) => {
        console.error("failed to load thread history", e);
        // Keep whatever we seeded from cache rather than blanking on error.
        if (active && !cached) setMessages([]);
      });

    const unsubscribe = api.wsClient.subscribeThread({
      threadId,
      getLastSeq: () => lastSeqRef.current,
      onFrame: (msg: CloudToClient) => {
        try {
          if (msg.t === "message") {
            setMessages((m) => {
              const next = [
                ...m,
                {
                  id: msg.messageId,
                  threadId: msg.threadId,
                  role: msg.role,
                  content: msg.content,
                  createdAt: msg.createdAt,
                },
              ];
              // Keep the cache in step with live appends so a switch-away /
              // switch-back shows the full conversation, not the GET snapshot.
              api.cache.set(cacheKey, next);
              return next;
            });
          } else if (msg.t === "event") {
            // Dedup by seq so a reconnect's catchup replay can't double-append.
            // Every event — including the terminal `done` / `error` — is kept;
            // `buildTimeline` uses the terminators to delimit turns and tell the
            // in-flight tail (no terminator yet) from completed turns.
            if (msg.seq <= lastSeqRef.current) return;
            lastSeqRef.current = msg.seq;
            if (!caughtUpRef.current) {
              // Initial catchup replay — buffer it, flushed as one batch on
              // catchup-complete so history doesn't paint pill-by-pill.
              replayBufferRef.current.push(msg.event);
            } else {
              const seq = msg.seq;
              setEvents((s) => {
                const next = [...s, msg.event];
                api.cache.set(evCacheKey, { events: next, lastSeq: seq });
                return next;
              });
            }
          } else if (msg.t === "host-status") {
            setHostOnline(msg.online);
          } else if (msg.t === "host-meta") {
            // Per-user host status push. The hook can't tell whether the host
            // is *this* thread's effective host (we don't track that yet), so
            // we treat any update as signal — same approximation as before.
            setHostOnline(msg.status === "online");
          } else if (msg.t === "catchup-complete") {
            if (msg.latestSeq > lastSeqRef.current) lastSeqRef.current = msg.latestSeq;
            // Initial replay done — paint the buffered history in one batch.
            flushReplay();
          } else if (msg.t === "catchup-too-long") {
            const targetSeq = msg.latestSeq;
            void api
              .getThread(threadId)
              .then((d) => {
                commitMessages(d.messages ?? []);
                lastSeqRef.current = targetSeq;
              })
              .catch((err) => console.error("catchup-too-long: getThread failed", err));
            // No replay is coming (too many events) — stop buffering so live
            // events append directly. History stays text-only (degraded mode).
            flushReplay();
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

    return () => {
      active = false;
      unsubscribe();
    };
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
    events,
    hostOnline,
    connected,
    send,
    pendingFallback,
    pendingNoHost,
    resolveFallback,
    dismissNoHost,
  };
}
