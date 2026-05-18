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
 *   - permission-request → PermissionPrompt (SP-3 will wire onAllow/onDeny to API)
 *
 * Banners:
 *   - WS dropped     → red "正在重连…"
 *   - host offline   → soft "本地运行环境未连接" warning
 *   - all hosts offline (SP-2) → NoHostBanner above composer
 */
import { useEffect, useRef, useState } from "react";
import type { MessageView } from "@cogni/contract";
import { useThreadStream } from "./useThreadStream.js";
import { Composer } from "./Composer.js";
import {
  UserMessage, AssistantText, ToolCallBlock, PermissionPrompt,
  aggregateEvents,
} from "./ChatBlocks.js";
import "./conversation.css";

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

  return (
    <div className="conversation">
      {!connected && (
        <div className="banner banner--danger">与服务器的连接已断开,正在重连…</div>
      )}
      {connected && !hostOnline && (
        <div className="banner banner--warning">
          本地运行环境未连接 —— 启动你电脑上的 Cogni 才能跑任务
        </div>
      )}

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
              return (
                <PermissionPrompt
                  key={i}
                  toolName={b.name}
                  what={<code>{JSON.stringify(b.input).slice(0, 120)}</code>}
                  onAllow={() => { /* SP-3: POST /permissions/:toolId allow=once */ }}
                  onDeny={() => { /* SP-3: POST /permissions/:toolId deny */ }}
                />
              );
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

      {/* SP-2: if no hosts are online at all, lift the NoHostBanner up here. */}
      {/* {noHostsAtAll && <NoHostBanner onOpenSettings={onOpenSettings} />} */}

      <Composer
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        disabled={!connected}
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
