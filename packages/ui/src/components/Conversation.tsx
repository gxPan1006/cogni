/**
 * Conversation — message list + composer for one thread.
 *
 * Visual rewrite: every block (user, assistant, tool call, error) lives in the
 * same vertical column with the same left edge — no two-column avatar layout.
 * Assistant text is rendered as Markdown.
 *
 * The streaming branch:
 *   - flat RunnerEvent[] → aggregateEvents() → renderable Block[]
 *   - text events concatenate into one running AssistantText (with caret)
 *   - tool-call + matching tool-result pair into one ToolCallBlock
 *   - error events render inline
 *   - permission-request blocks are dropped (SP-3 chose to trust the
 *     sandbox + reviewing-state human review rather than ship a mid-run
 *     permission UI). The block kind still exists for ChatBlocks consumers
 *     that want it; Conversation just ignores it now.
 *
 * Connection / host state: surfaced through the composer's status pill —
 * there is no top-of-conversation banner anymore. We compute a
 * `ComposerStatus` from `connected` + `hostOnline` + the optional
 * `hostName` and hand it to <Composer status={…} />.
 */
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../transport/api.js";
import { useThreadStream } from "../hooks/useThreadStream.js";
import { useUploads } from "../hooks/useUploads.js";
import { Composer, type ComposerStatus } from "./Composer.js";
import { HostFallbackCard } from "./HostFallbackCard.js";
import { NoHostBanner } from "./NoHostBanner.js";
import { LoadingRows } from "./LoadingState.js";
import {
  UserMessage, AssistantText, AssistantBlocks,
  buildTimeline,
} from "./ChatBlocks.js";
import "./conversation.css";

export function Conversation({
  api,
  threadId,
  initialDraft,
  onConsumeInitialDraft,
  hostName,
}: {
  api: ApiClient;
  threadId: string;
  /** First message handed in from Welcome — auto-sent once the WS connects. */
  initialDraft?: string;
  onConsumeInitialDraft?: () => void;
  onTitleMaybeChanged?: () => void;
  /** Name of the host this thread is routed to. Shown above the composer. */
  hostName?: string;
}) {
  const {
    messages, events, loading, hostOnline, connected, send, stalled, retry,
    pendingFallback, pendingNoHost, resolveFallback,
  } = useThreadStream(api, threadId);
  const [draft, setDraft] = useState("");
  const uploads = useUploads((file, onProgress) => api.uploadFile(threadId, file, onProgress));
  const consumedInitial = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Welcome → first message: send as soon as the WS is connected.
  useEffect(() => {
    if (!consumedInitial.current && initialDraft && connected) {
      if (send(initialDraft)) {
        consumedInitial.current = true;
        onConsumeInitialDraft?.();
      }
    }
  }, [connected, initialDraft, send, onConsumeInitialDraft]);

  // Auto-scroll to bottom on every change. SP-1 pins unconditionally; the
  // "stay pinned only if user was at bottom" UX lands later.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, events]);

  const submit = () => {
    if (!draft.trim()) return;
    const attachments = uploads.takeAttachments();
    if (send(draft, attachments)) setDraft("");
  };

  const { rows, awaitingReply } = buildTimeline(messages, events);
  const isEmpty = rows.length === 0;
  // Typing indicator while the last user turn has produced no frames yet — but
  // once a turn is declared stalled we swap the spinner for the failure card.
  const showTyping = awaitingReply && !stalled;

  const status: ComposerStatus | undefined =
    !connected
      ? { kind: "danger", text: "与服务器的连接已断开,正在重连…" }
      : !hostOnline
        ? hostName
          ? { kind: "warn", hostName, text: "离线 · 等待上线" }
          : { kind: "danger", text: "没有在线的 Cogni 桌面端" }
        : hostName
          ? { kind: "ok", hostName }
          : undefined;

  return (
    <div className="conversation">
      <div className="conversation__scroll" ref={scrollRef}>
        <div className="conversation__list">
          {isEmpty && (
            loading
              // First load of an uncached thread — show a skeleton, never the
              // "empty conversation" placeholder (which used to flash before
              // the history arrived).
              ? <LoadingRows rows={4} />
              : <div className="conversation__empty">开始你的对话吧</div>
          )}

          {/* Whole conversation, event-sourced: user turns interleaved with
              assistant turns reconstructed from their events (prose + tool-call
              pills). Tool pills persist past `done` and across reloads.
              Permission blocks are not surfaced — SP-3 dropped the mid-run
              permission UI (spec §一 YAGNI); the runner-host runs with
              `--dangerously-skip-permissions` and reviewing-state human review
              is the safety net. */}
          {rows.map((row) => {
            if (row.kind === "user") return <UserMessage key={row.key} text={row.text} />;
            if (row.kind === "system") {
              return (
                <div key={row.key} className="msg msg--aux">
                  <div className="conversation__system">{row.text}</div>
                </div>
              );
            }
            if (row.kind === "assistant-text") return <AssistantText key={row.key} text={row.text} />;
            return <AssistantBlocks key={row.key} blocks={row.blocks} streaming={row.streaming} />;
          })}

          {showTyping && (
            <div className="msg msg--assistant">
              <span className="typing-dots" aria-label="正在思考">
                <span className="typing-dots__dot" />
                <span className="typing-dots__dot" />
                <span className="typing-dots__dot" />
              </span>
            </div>
          )}

          {/* Turn went quiet past the stall timeout — stop pretending to work,
              tell the user, and offer a re-sync. Replaces the dots when the
              turn never produced anything; sits below partial content when a
              stream froze mid-reply. */}
          {stalled && (
            <div className="msg msg--assistant">
              <div className="turn-stall" role="alert">
                <span className="turn-stall__text">
                  回复好像没收到 —— 可能是网络波动或桌面端临时掉线。
                </span>
                <button type="button" className="turn-stall__retry" onClick={retry}>
                  重试
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* SP-2 multi-host UX. Either of these is showing → composer is also disabled. */}
      {pendingFallback && (
        <HostFallbackCard
          preferred={pendingFallback.preferred}
          alternatives={pendingFallback.alternatives}
          onSwitch={(targetHostId) => resolveFallback("switch", targetHostId)}
          onCancel={() => resolveFallback("cancel")}
        />
      )}
      {pendingNoHost && <NoHostBanner />}

      <Composer
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        disabled={!connected || pendingFallback !== null || pendingNoHost !== null}
        status={status}
        uploads={uploads}
      />
    </div>
  );
}
