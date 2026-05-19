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
import type { MessageView } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";
import { useThreadStream } from "../hooks/useThreadStream.js";
import { Composer, type ComposerStatus } from "./Composer.js";
import { HostFallbackCard } from "./HostFallbackCard.js";
import { NoHostBanner } from "./NoHostBanner.js";
import {
  UserMessage, AssistantText, ToolCallBlock,
  aggregateEvents,
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
    messages, streaming, hostOnline, connected, send,
    pendingFallback, pendingNoHost, resolveFallback,
  } = useThreadStream(api, threadId);
  const [draft, setDraft] = useState("");
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
  }, [messages, streaming]);

  const submit = () => {
    if (!draft.trim()) return;
    if (send(draft)) setDraft("");
  };

  const streamingBlocks = aggregateEvents(streaming);
  const isEmpty = messages.length === 0 && streamingBlocks.length === 0;
  // Typing indicator only when we know a turn is in flight but no frames yet.
  const showTyping =
    streamingBlocks.length === 0 &&
    messages.length > 0 &&
    messages[messages.length - 1]?.role === "user";

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
            <div className="conversation__empty">开始你的对话吧</div>
          )}

          {messages.map((m) => <MessageRow key={m.id} message={m} />)}

          {/* Streaming aggregate */}
          {streamingBlocks.map((b, i) => {
            if (b.kind === "text") {
              return <AssistantText key={i} text={b.text} streaming />;
            }
            if (b.kind === "tool") {
              return <ToolCallBlock key={i} name={b.name} input={b.input} result={b.result} status={b.status} />;
            }
            if (b.kind === "permission") {
              // SP-3: permission middleware was explicitly dropped (spec §一 YAGNI).
              // The block exists in the event stream for backwards compatibility
              // but the UI no longer surfaces it — runner-host runs with
              // `--dangerously-skip-permissions`, and reviewing-state human
              // review is the safety net.
              return null;
            }
            if (b.kind === "error") {
              return (
                <div key={i} className="msg msg--aux">
                  <div className="conversation__error">⚠ {b.code}: {b.message}</div>
                </div>
              );
            }
            return null;
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
      />
    </div>
  );
}

function MessageRow({ message }: { message: MessageView }) {
  if (message.role === "user")      return <UserMessage text={message.content} />;
  if (message.role === "assistant") return <AssistantText text={message.content} />;
  // system / future roles — render as muted prose
  return (
    <div className="msg msg--aux">
      <div className="conversation__system">{message.content}</div>
    </div>
  );
}
