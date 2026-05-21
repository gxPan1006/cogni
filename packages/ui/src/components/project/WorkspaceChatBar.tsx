/**
 * WorkspaceChatBar — the bottom-anchored orchestrator chat dock.
 *
 * Direct experience:
 *   - Collapsed: a single rounded input bar pinned to the bottom of the list /
 *     board view, with a scope-aware placeholder ("让 Cogni 帮你建任务…" on the
 *     workspace list, "在「<项目名>」里…" inside a board).
 *   - Focus / click the bar → it expands UPWARD into a rounded popup that holds
 *     the conversation (user turns + assistant prose + tool-call pills, reusing
 *     the same blocks as <Conversation>) plus a real <Composer> at the bottom.
 *   - Close (×) collapses back to the bar.
 *
 * Behaviour:
 *   - On mount it resolves the orchestrator thread id (workspace-wide or
 *     project-scoped) via the api, then streams it with `useThreadStream`.
 *   - When the user's local Cogni host is offline (or the WS is down) the
 *     composer is disabled and shows a red pill "需要本地 Cogni 在线才能编排" —
 *     the orchestrator can't act without hands on the local machine.
 *
 * Architecture: this is a thin shell over the existing chat primitives. It does
 * NOT introduce its own message model — `buildTimeline` + the ChatBlocks
 * components do all the rendering, exactly like <Conversation>.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ApiClient } from "../../transport/api.js";
import { useThreadStream } from "../../hooks/useThreadStream.js";
import { buildTimeline } from "../chat-timeline.js";
import { UserMessage, AssistantText, AssistantBlocks } from "../ChatBlocks.js";
import { Composer } from "../Composer.js";
import "./workspace-chat.css";

export type WorkspaceChatScope =
  | { kind: "workspace" }
  | { kind: "project"; projectId: string; projectName: string };

/**
 * The task card the user last opened on this board — surfaced as a dismissible
 * "focus chip" above the orchestrator composer and ridden along on send so the
 * model knows which card vague phrasing ("这个" / "改一下") refers to.
 */
export type WorkspaceTaskFocus = { id: string; ref: string; title: string };

/**
 * Pure scope → idle placeholder mapping (unit-tested in WorkspaceChatBar.test.ts).
 *
 * `t` is optional: when provided (React render path) the text comes from the
 * i18n catalog and tracks the active language; when omitted the original
 * Chinese literals are returned, so the unit test and any non-React caller
 * keep working unchanged.
 */
export function scopePlaceholder(scope: WorkspaceChatScope, t?: TFunction): string {
  if (scope.kind !== "project") {
    return t ? t("project.chatbar.placeholderWorkspace") : "让 Cogni 帮你建任务、关任务、整理项目…";
  }
  // Guard a missing/blank project name so the placeholder never reads the
  // literal「undefined」 (a half-loaded or nameless project row).
  const fallbackName = t ? t("project.chatbar.placeholderProjectFallback") : "这个项目";
  const name = scope.projectName?.trim() ? scope.projectName.trim() : fallbackName;
  return t ? t("project.chatbar.placeholderProject", { name }) : `在「${name}」里帮你建任务、改任务…`;
}

export function WorkspaceChatBar({
  api,
  scope,
}: {
  api: ApiClient;
  scope: WorkspaceChatScope;
}) {
  const { t } = useTranslation();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Resolve the orchestrator thread id for the current scope. Re-runs when the
  // scope flips (workspace ↔ project) or the active project changes.
  const projectId = scope.kind === "project" ? scope.projectId : "";
  useEffect(() => {
    let live = true;
    const p =
      scope.kind === "project"
        ? api.getProjectChatThread(scope.projectId)
        : api.getWorkspaceThread();
    p.then((r) => {
      if (live) setThreadId(r.threadId);
    }).catch(() => {
      /* leave threadId null → popup shows nothing actionable until resolved */
    });
    return () => {
      live = false;
    };
  }, [api, scope.kind, projectId]);

  return (
    <div className={"wschat" + (open ? " wschat--open" : "")}>
      {open && threadId && (
        <WorkspaceChatPopup api={api} threadId={threadId} onClose={() => setOpen(false)} />
      )}
      <input
        className="wschat__bar"
        placeholder={scopePlaceholder(scope, t)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        readOnly
        aria-label={t("project.chatbar.ariaInput")}
      />
    </div>
  );
}

function WorkspaceChatPopup({
  api,
  threadId,
  onClose,
}: {
  api: ApiClient;
  threadId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { messages, events, hostOnline, connected, send } = useThreadStream(api, threadId);
  const { rows } = buildTimeline(messages, events);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Pin to bottom on every new row so the latest exchange stays in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const submit = () => {
    if (draft.trim() && send(draft)) setDraft("");
  };
  const disabled = !connected || !hostOnline;

  return (
    <div className="wschat__popup" data-testid="wschat-popup">
      <div className="wschat__head">
        <span>{t("project.chatbar.title")}</span>
        <button className="wschat__close" onClick={onClose} aria-label={t("project.chatbar.collapse")} type="button">
          ×
        </button>
      </div>
      <div className="wschat__body" ref={scrollRef}>
        {rows.length === 0 && (
          <div className="wschat__empty">{t("project.chatbar.empty")}</div>
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
        placeholder={t("project.chatbar.composerPlaceholder")}
        status={disabled ? { kind: "danger", text: t("project.chatbar.offline") } : undefined}
      />
    </div>
  );
}
