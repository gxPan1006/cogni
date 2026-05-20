import { useEffect, useMemo, useRef, useState } from "react";
import type { MessageView, RunnerEvent, CloudToClient } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";
import { buildTimeline, isAwaitingProgress } from "../components/chat-timeline.js";

/**
 * How long a turn may sit with no visible progress (no new frame at all) before
 * we declare it stalled and surface a failure + retry affordance instead of an
 * infinite "• • •". Picked generously: a healthy first frame lands within a few
 * seconds, so a full minute of total silence is unambiguous trouble — while a
 * running tool (a long build) is excluded from the timer entirely
 * (`isAwaitingProgress`), so this never false-flags a slow-but-healthy command.
 */
const STALL_TIMEOUT_MS = 60_000;

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
  // True only while a thread with NO cached snapshot is doing its first
  // history fetch. Lets the view show a loading state instead of the "empty
  // conversation" placeholder, which used to flash before the history loaded.
  const [loading, setLoading] = useState(false);
  const [hostOnline, setHostOnline] = useState(true);
  const [connected, setConnected] = useState(() => api.wsClient.isConnected());
  const [pendingFallback, setPendingFallback] = useState<PendingFallback | null>(null);
  const [pendingNoHost, setPendingNoHost] = useState<PendingNoHost | null>(null);
  // A turn that's been waiting past STALL_TIMEOUT_MS with no frame — the
  // "reply never came back" state. Drives the failure card + retry button so a
  // lost dispatch doesn't spin "• • •" forever.
  const [stalled, setStalled] = useState(false);
  // Bumped by `retry()` to force the subscription effect to tear down and
  // re-run — a fresh getThread + re-subscribe that replays anything the cloud
  // has past our lastSeq (recovers frames dropped by a flaky connection).
  const [reloadNonce, setReloadNonce] = useState(0);
  // Survives subscribe/unsubscribe and (re)connects for this hook instance.
  // Reset to 0 only when the threadId changes.
  const lastSeqRef = useRef<number>(0);
  // The initial catchup replay is buffered and flushed in a single batch on
  // `catchup-complete` (see effect). Without this, switching into a thread
  // paints the text first and then lets tool-call pills pop in one event at a
  // time as the replay frames arrive — the "loading flash" on session switch.
  const caughtUpRef = useRef(false);
  const replayBufferRef = useRef<RunnerEvent[]>([]);
  const threadIdRef = useRef<string | null>(null);

  // Reset the thread-scoped display state SYNCHRONOUSLY when threadId changes —
  // during render, before the first paint. React's documented "adjust state on
  // prop change" pattern (the conditional setState bails out and re-renders
  // immediately with the new values). If we deferred this to the subscription
  // effect (which runs *after* paint), the new thread's first frame would show
  // the previous thread's state — or, on a cold open, the "empty conversation"
  // placeholder — until the effect caught up. That was the load flash.
  if (threadIdRef.current !== threadId) {
    threadIdRef.current = threadId;
    const seededMsgs = api.cache.get<MessageView[]>(`thread:${threadId}`) ?? [];
    const seededEv = api.cache.get<{ events: RunnerEvent[]; lastSeq: number }>(`events:${threadId}`);
    setMessages(seededMsgs);
    setEvents(seededEv?.events ?? []);
    // Show the loading skeleton only when there's no cached snapshot to paint.
    setLoading(seededMsgs.length === 0 && (seededEv?.events.length ?? 0) === 0);
    lastSeqRef.current = seededEv?.lastSeq ?? 0;
    caughtUpRef.current = false;
    replayBufferRef.current = [];
  }

  // Bind `connected` to the shared connection — independent of threadId so
  // switching threads doesn't flap the pill.
  useEffect(() => {
    const ws = api.wsClient;
    setConnected(ws.isConnected());
    return ws.onConnectionChange(setConnected);
  }, [api]);

  // Subscription lifecycle — fetches history + opens the live subscription.
  // Display state (messages/events/loading/lastSeqRef) is seeded synchronously
  // in the during-render block above; this effect only drives the async work.
  useEffect(() => {
    setPendingFallback(null);
    setPendingNoHost(null);

    const cacheKey = `thread:${threadId}`;
    const evCacheKey = `events:${threadId}`;

    // Guards a stale getThread/catchup resolving after the user already moved
    // on — without this the late promise would clobber the new thread's view.
    let active = true;
    const commitMessages = (msgs: MessageView[]) => {
      api.cache.set(cacheKey, msgs);
      if (active) setMessages(msgs);
    };

    // Drop the most recent optimistic (un-acked) user message. Called when the
    // cloud says the send didn't actually dispatch (no host online / fallback
    // prompt) so we don't leave a phantom "sent" bubble on screen.
    const rollbackOptimistic = () => {
      if (!active) return;
      setMessages((m) => {
        for (let i = m.length - 1; i >= 0; i--) {
          const row = m[i];
          if (row && row.role === "user" && row.id.startsWith("pending:")) {
            const next = m.slice(0, i).concat(m.slice(i + 1));
            api.cache.set(cacheKey, next);
            return next;
          }
        }
        return m;
      });
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

    // C: when the WS is live, the cloud seeds the message history over that
    // already-warm socket via a `thread-snapshot` frame (handled in onFrame
    // below), so we skip the separate HTTP getThread. That HTTP request rides a
    // connection that idle-closes between clicks, so it routinely pays a full
    // ~1s TLS handshake — the dominant cause of "clicking a thread is slow".
    // Fall back to HTTP only when the socket is down, so a fresh open still
    // loads while the WS is (re)connecting.
    if (!api.wsClient.isConnected()) {
      api
        .getThread(threadId)
        .then((d) => commitMessages(d.messages ?? []))
        .catch((e) => {
          console.error("failed to load thread history", e);
          // Keep whatever was seeded from cache during render rather than blanking.
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }

    const unsubscribe = api.wsClient.subscribeThread({
      threadId,
      getLastSeq: () => lastSeqRef.current,
      onFrame: (msg: CloudToClient) => {
        try {
          if (msg.t === "message") {
            setMessages((m) => {
              const incoming: MessageView = {
                id: msg.messageId,
                threadId: msg.threadId,
                role: msg.role,
                content: msg.content,
                createdAt: msg.createdAt,
                // #3: carry attachment metadata so the bubble shows file cards
                // on the live broadcast (not only after an HTTP reload).
                ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
              };
              // #4: reconcile our optimistic echo — replace the matching
              // `pending:` user message in place so it doesn't double up and
              // adopts the persisted id. (No turn-correlation id exists, so we
              // match on role+content; identical back-to-back sends are rare.)
              let next: MessageView[];
              if (msg.role === "user") {
                const idx = m.findIndex(
                  (x) => x.id.startsWith("pending:") && x.role === "user" && x.content === msg.content,
                );
                if (idx >= 0) { next = m.slice(); next[idx] = incoming; }
                else next = [...m, incoming];
              } else {
                next = [...m, incoming];
              }
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
          } else if (msg.t === "thread-snapshot") {
            // C: cold-open message history delivered over the warm WS (replaces
            // the HTTP getThread). Preserve any optimistic `pending:` user
            // bubble the user fired before the snapshot landed, then drop the
            // loading skeleton.
            if (active) {
              setMessages((cur) => {
                const pending = cur.filter((x) => x.id.startsWith("pending:"));
                const next = pending.length > 0 ? [...msg.messages, ...pending] : msg.messages;
                api.cache.set(cacheKey, next);
                return next;
              });
              setLoading(false);
            }
          } else if (msg.t === "catchup-complete") {
            if (msg.latestSeq > lastSeqRef.current) lastSeqRef.current = msg.latestSeq;
            // Initial replay done — paint the buffered history in one batch.
            flushReplay();
            // Safety net: clears the skeleton even for a thread with messages
            // but zero events (snapshot path) or if a snapshot never arrived.
            if (active) setLoading(false);
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
            rollbackOptimistic(); // the send is parked pending the user's host choice
          } else if (msg.t === "no-host-online") {
            setPendingNoHost({ pendingMessageId: msg.pendingMessageId });
            rollbackOptimistic(); // nothing dispatched — don't leave a phantom bubble
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
  }, [api, threadId, reloadNonce]);

  // Stall detection. Arm a one-shot timer whenever the thread is waiting on the
  // runner with no visible progress (see `isAwaitingProgress`). Any new
  // message/event re-runs this effect → clears the old timer and `stalled`, so
  // each frame "resets the clock"; only true silence past STALL_TIMEOUT_MS
  // flips `stalled`. Skipped while the socket is down or the host is offline —
  // those have their own composer pill, and reconnect will replay what we
  // missed.
  const awaitingProgress = useMemo(
    () => isAwaitingProgress(buildTimeline(messages, events)),
    [messages, events],
  );
  useEffect(() => {
    setStalled(false);
    if (!awaitingProgress || !connected || !hostOnline) return;
    const id = setTimeout(() => setStalled(true), STALL_TIMEOUT_MS);
    return () => clearTimeout(id);
    // events.length / messages.length are the "a frame arrived" signal: each new
    // frame re-runs this effect, resetting the clock so a long healthy stream
    // never false-stalls. Bare-dots (no frames) leaves them static → timer fires.
  }, [awaitingProgress, connected, hostOnline, reloadNonce, events.length, messages.length]);

  const send = (text: string, attachments?: { name: string; size: number }[], taskId?: string, model?: string) => {
    const ok = api.wsClient.send(threadId, text, attachments, taskId, model);
    if (ok) {
      // #4: optimistic echo — paint the user's message instantly instead of
      // waiting for the cloud's `message` broadcast round-trip. The "pending:"
      // id is reconciled (or rolled back) when the cloud responds.
      const optimistic: MessageView = {
        id: `pending:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        threadId,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      setMessages((m) => {
        const next = [...m, optimistic];
        api.cache.set(`thread:${threadId}`, next);
        return next;
      });
    }
    return ok;
  };

  // Re-sync this thread from the cloud: refetch history and re-subscribe so any
  // events the cloud holds past our lastSeq replay. Safe and idempotent — it
  // never re-sends the prompt (which, without a turn-correlation id, would
  // duplicate the user message), so it can't corrupt the timeline.
  const retry = () => {
    setStalled(false);
    setReloadNonce((n) => n + 1);
  };

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
    loading,
    hostOnline,
    connected,
    send,
    stalled,
    retry,
    pendingFallback,
    pendingNoHost,
    resolveFallback,
    dismissNoHost,
  };
}
