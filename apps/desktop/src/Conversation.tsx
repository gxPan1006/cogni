/**
 * Conversation — message list + composer for one thread.
 *
 * Owned by Track B. Phase 1 settled: props, top-level className, and the
 * first-message handoff from Welcome (initialDraft → auto-send on connect).
 * Track B (this revision) fills in:
 *   • message bubble styles (.message--user, .message--assistant, .message--system)
 *   • tool-pill / tool-result / event-error rendering inside streaming/EventBlock
 *   • streaming typing-dots indicator (shown before the first chunk arrives)
 *   • banner placement (.banner / --warning / --danger are in base.css)
 *   • auto-scroll-to-bottom on new messages / streaming events
 *
 * Visual target: ai-cognit webchat messages list + composer (composer-block at
 * /Users/guoxunpan/code/ai-cognit/backend/src/channels/webchat/static/index.html
 * lines 95-156). user messages = right-aligned bubble; assistant = left-aligned
 * unbubbled prose with a small ✳ marker.
 */
import { useEffect, useRef } from "react";
import { useState } from "react";
import type { RunnerEvent } from "@cogni/contract";
import { useThreadStream } from "./useThreadStream.js";
import { Composer } from "./Composer.js";
import "./conversation.css";

/** One rendered runner-event inside the streaming assistant turn. */
function EventBlock({ event }: { event: RunnerEvent }) {
  if (event.type === "text") return <span>{event.text}</span>;
  if (event.type === "tool-call") {
    const preview = JSON.stringify(event.input ?? {});
    return (
      <pre className="tool-pill">
        <span className="tool-pill__icon" aria-hidden="true">🔧</span>
        <span className="tool-pill__name">{event.name}</span>
        <span className="tool-pill__args">{preview.slice(0, 120)}{preview.length > 120 ? "…" : ""}</span>
      </pre>
    );
  }
  if (event.type === "tool-result") {
    const out = String(event.output ?? "");
    return (
      <pre className="tool-result">
        <span className="tool-result__arrow" aria-hidden="true">↳</span>
        <span className="tool-result__body">{out.slice(0, 200)}{out.length > 200 ? "…" : ""}</span>
      </pre>
    );
  }
  if (event.type === "error") {
    return (
      <pre className="event-error">
        <span aria-hidden="true">⚠</span> {event.code}: {event.message}
      </pre>
    );
  }
  // `permission-request` falls through — no permission UI until SP-3.
  return null;
}

export function Conversation({
  token,
  threadId,
  initialDraft,
  onConsumeInitialDraft,
}: {
  token: string;
  threadId: string;
  /** First message handed in from Welcome — auto-sent once the WS connects. */
  initialDraft?: string;
  onConsumeInitialDraft?: () => void;
  onTitleMaybeChanged?: () => void;
}) {
  const { messages, streaming, hostOnline, connected, send } = useThreadStream(token, threadId);
  const [draft, setDraft] = useState("");
  const consumedInitial = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Welcome → first message: as soon as the WS is connected, fire and clear.
  useEffect(() => {
    if (!consumedInitial.current && initialDraft && connected) {
      if (send(initialDraft)) {
        consumedInitial.current = true;
        onConsumeInitialDraft?.();
      }
    }
  }, [connected, initialDraft, send, onConsumeInitialDraft]);

  // Auto-scroll to bottom whenever new messages land or the streaming turn
  // grows. We pin to the bottom unconditionally for SP-1 — "stay-pinned-only-
  // if-user-was-at-bottom" can land later with the scrollback UX work.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const submit = () => {
    if (!draft.trim()) return;
    if (send(draft)) setDraft("");
  };

  const isEmpty = messages.length === 0 && streaming.length === 0;
  // Show the typing indicator only when we know a turn is in flight but the
  // server hasn't streamed any text/tool frames yet.
  const showTyping = streaming.length === 0 && messages.length > 0 &&
    messages[messages.length - 1]?.role === "user";

  return (
    <div className="conversation">
      {!connected && (
        <div className="banner banner--danger">
          与服务器的连接已断开,正在重连…
        </div>
      )}
      {connected && !hostOnline && (
        <div className="banner banner--warning">
          本地运行环境未连接 —— 启动你电脑上的 Cogni 才能跑任务
        </div>
      )}

      <div className="conversation__scroll" ref={scrollRef}>
        <div className="conversation__list">
          {isEmpty && (
            <div className="conversation__empty">
              <span className="conversation__empty-star" aria-hidden="true">✳</span>
              <span>开始你的对话吧</span>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={"message message--" + m.role}>
              {m.role === "assistant" && (
                <span className="message__avatar" aria-hidden="true">✳</span>
              )}
              <div className="message__col">
                <div className="message__role">
                  {m.role === "user" ? "你" : m.role === "assistant" ? "Cogni" : "系统"}
                </div>
                <div className="message__body selectable">{m.content}</div>
              </div>
            </div>
          ))}

          {(streaming.length > 0 || showTyping) && (
            <div className="message message--assistant message--streaming">
              <span className="message__avatar" aria-hidden="true">✳</span>
              <div className="message__col">
                <div className="message__role">Cogni</div>
                <div className="message__body selectable">
                  {streaming.map((e, i) => <EventBlock key={i} event={e} />)}
                  {showTyping && (
                    <span className="typing-dots" aria-label="正在思考">
                      <span className="typing-dots__dot" />
                      <span className="typing-dots__dot" />
                      <span className="typing-dots__dot" />
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <Composer
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        disabled={!connected}
      />
    </div>
  );
}
