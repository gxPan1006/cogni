/**
 * SessionView — one orchestrator conversation inside the bubble.
 *
 * Direct experience: a back arrow + the session title + a live host dot up top,
 * the streamed transcript in the middle (real user/assistant turns with the
 * cogni tool-call pills that show task/project mutations), and a composer at the
 * bottom. With no local Cogni host online the composer is disabled and shows a
 * red "需要本地 Cogni 在线才能编排" pill — the orchestrator can't act otherwise.
 *
 * Behaviour: streams via `useThreadStream` (same engine as the main chat), so
 * switching away and back re-subscribes and replays history — messages never
 * get lost. The first user message of a brand-new session renames it (locally +
 * persisted) so the list row stops reading "New conversation".
 */
import { useEffect, useRef } from "react";
import type { ThreadSummary } from "@cogni/contract";
import type { ApiClient } from "../../../transport/api.js";
import { useThreadStream } from "../../../hooks/useThreadStream.js";
import { buildTimeline } from "../../chat-timeline.js";
import { UserMessage, AssistantText, AssistantBlocks } from "../../ChatBlocks.js";
import { Composer } from "../../Composer.js";
import { Icon } from "../../icons.js";

export function SessionView({
  api,
  session,
  draft,
  setDraft,
  placeholder,
  onBack,
  onTitled,
}: {
  api: ApiClient;
  session: ThreadSummary;
  draft: string;
  setDraft: (v: string) => void;
  placeholder: string;
  onBack: () => void;
  /** Fired after the first user turn renames a fresh session. */
  onTitled: (id: string, title: string) => void;
}) {
  const { messages, events, hostOnline, connected, send } = useThreadStream(api, session.id);
  const { rows } = buildTimeline(messages, events);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Pin to bottom as the conversation grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const disabled = !connected || !hostOnline;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (!send(draft)) return;
    setDraft("");
    // First turn of an untitled session → derive a title from the message.
    if (rows.length === 0 && /^(New conversation|Workspace|Project chat)$/.test(session.title)) {
      const title = text.slice(0, 48);
      onTitled(session.id, title);
      api.renameThread(session.id, title).catch(() => {
        /* cosmetic; the row still shows the optimistic title until reload */
      });
    }
  };

  return (
    <>
      <div className="cb-session-head">
        <button className="cb-icon-btn cb-back" onClick={onBack} title="全部会话" type="button">
          {Icon.arrow}
        </button>
        <div className="cb-session-title-wrap">
          <div className="cb-session-title">{session.title}</div>
          <div className="cb-session-sub">
            <span className={"cb-dot " + (hostOnline && connected ? "is-online" : "is-offline")} />
            <span className="cb-session-host">
              {connected ? (hostOnline ? "本地 Cogni 在线" : "本地 Cogni 离线") : "重连中…"}
            </span>
          </div>
        </div>
      </div>

      <div className="cb-scroll" ref={scrollRef}>
        {rows.length === 0 && (
          <div className="cb-empty">告诉 Cogni 你想建/改/删什么任务或项目。</div>
        )}
        {rows.map((row) => {
          if (row.kind === "user") return <UserMessage key={row.key} text={row.text} attachments={row.attachments} />;
          if (row.kind === "assistant-text") return <AssistantText key={row.key} text={row.text} />;
          if (row.kind === "system") return null;
          return <AssistantBlocks key={row.key} blocks={row.blocks} streaming={row.streaming} />;
        })}
      </div>

      <Composer
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        disabled={disabled}
        placeholder={placeholder}
        status={disabled ? { kind: "danger", text: "需要本地 Cogni 在线才能编排" } : undefined}
      />
    </>
  );
}
