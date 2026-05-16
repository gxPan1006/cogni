/**
 * Conversation — message list + composer for one thread.
 *
 * Owned by Track B. Phase 1 settled: props, top-level className, and the
 * first-message handoff from Welcome (initialDraft → auto-send on connect).
 * Track B fills in:
 *   • message bubble styles (.message--user, .message--assistant, etc.)
 *   • tool-pill rendering (.tool-pill, .tool-result)
 *   • streaming indicator
 *   • banner styling (.banner--warning / --danger already live in base.css)
 *   • Composer.tsx (its sibling — toolbar with attach / model / voice / send)
 *
 * Visual target: ai-cognit webchat messages list + composer (composer-block at
 * /Users/guoxunpan/code/ai-cognit/backend/src/channels/webchat/static/index.html
 * lines 103-147).
 */
import { useEffect, useRef, useState } from "react";
import type { RunnerEvent } from "@cogni/contract";
import { useThreadStream } from "./useThreadStream.js";
import { Composer } from "./Composer.js";
import "./conversation.css";

function EventBlock({ event }: { event: RunnerEvent }) {
  if (event.type === "text") return <span>{event.text}</span>;
  if (event.type === "tool-call")
    return <pre className="tool-pill">🔧 {event.name}({JSON.stringify(event.input)})</pre>;
  if (event.type === "tool-result")
    return <pre className="tool-result">↳ {String(event.output).slice(0, 200)}</pre>;
  if (event.type === "error")
    return <pre className="event-error">⚠ {event.code}: {event.message}</pre>;
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

  // Welcome → first message: as soon as the WS is connected, fire and clear.
  useEffect(() => {
    if (!consumedInitial.current && initialDraft && connected) {
      if (send(initialDraft)) {
        consumedInitial.current = true;
        onConsumeInitialDraft?.();
      }
    }
  }, [connected, initialDraft, send, onConsumeInitialDraft]);

  const submit = () => {
    if (!draft.trim()) return;
    if (send(draft)) setDraft("");
  };

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

      <div className="conversation__scroll">
        {messages.map((m) => (
          <div key={m.id} className={"message message--" + m.role}>
            <div className="message__role">
              {m.role === "user" ? "你" : m.role === "assistant" ? "Cogni" : "系统"}
            </div>
            <div className="message__body selectable">{m.content}</div>
          </div>
        ))}
        {streaming.length > 0 && (
          <div className="message message--assistant message--streaming">
            <div className="message__role">Cogni</div>
            <div className="message__body selectable">
              {streaming.map((e, i) => <EventBlock key={i} event={e} />)}
            </div>
          </div>
        )}
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
