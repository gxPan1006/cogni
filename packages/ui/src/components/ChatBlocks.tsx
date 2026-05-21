/**
 * ChatBlocks — all the building blocks for the conversation surface.
 *
 *   - <UserMessage>      a user's turn (a soft sand chip with markdown body)
 *   - <AssistantText>    the assistant's prose; supports markdown + streaming caret
 *   - <AssistantBlocks>  one assistant turn: prose + interleaved tool-call pills
 *   - <ToolCallBlock>    one tool invocation; collapsible to show input + result
 *   - <PermissionPrompt> SP-3 permission-request UI
 *   - <ThinkingBlock>    reserved — runner adapters don't emit thinking events yet
 *   - <SessionSwitch>    inline divider when a thread migrates to a new host
 *   - <FallbackCard>     "preferred host is offline" inline prompt
 *   - <NoHostBanner>     "no host is online at all" hard banner
 *
 * The pure timeline logic (aggregateEvents / splitTurns / buildTimeline) lives
 * in `./chat-timeline.ts` — kept React/CSS-free so it is unit-testable — and is
 * re-exported here for existing consumers.
 *
 * All blocks share the same left-edge column. There is no left rail or avatar
 * column — alignment is preserved by giving every block the same outer padding.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "./Markdown.js";
import { Icon } from "./icons.js";
import { AttachmentCard } from "./AttachmentCard.js";
import { toolInputPreview, safeStringify, truncate, type Block } from "./chat-timeline.js";
import "./chat-blocks.css";

// Re-exported so existing consumers keep importing the timeline logic from
// ChatBlocks; the implementation lives in the React-free chat-timeline module.
export {
  aggregateEvents, splitTurns, buildTimeline,
  type Block, type TimelineRow, type Timeline,
} from "./chat-timeline.js";

// ─── Block components ────────────────────────────────────────────

export function UserMessage({
  text,
  attachments,
}: {
  text: string;
  attachments?: { name: string; size: number }[];
}) {
  return (
    <div className="msg msg--user">
      <div className="msg__user-card">
        {attachments && attachments.length > 0 && (
          <div className="att-tray msg__att-tray">
            {attachments.map((a) => (
              <AttachmentCard key={a.name} name={a.name} size={a.size} />
            ))}
          </div>
        )}
        {text.trim().length > 0 && <Markdown text={text} />}
      </div>
    </div>
  );
}

export function AssistantText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="msg msg--assistant">
      <div className="msg__assistant-body">
        <Markdown text={text} />
        {streaming && <span className="msg__caret" aria-hidden="true" />}
      </div>
    </div>
  );
}

/**
 * One assistant turn rendered from its aggregated blocks: prose + interleaved
 * tool-call pills (+ inline errors). Used for both the live, in-flight reply
 * and every settled turn in history — the only difference is `streaming`,
 * which draws the caret on the turn's last text block.
 */
export function AssistantBlocks({
  blocks,
  streaming = false,
  errorClassName = "conversation__error",
}: {
  blocks: Block[];
  streaming?: boolean;
  errorClassName?: string;
}) {
  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === "text") { lastTextIdx = i; break; }
  }
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "text") {
          return <AssistantText key={i} text={b.text} streaming={streaming && i === lastTextIdx} />;
        }
        if (b.kind === "tool") {
          return <ToolCallBlock key={i} name={b.name} input={b.input} result={b.result} status={b.status} />;
        }
        if (b.kind === "error") {
          return (
            <div key={i} className="msg msg--aux">
              <div className={errorClassName}>⚠ {b.code}: {b.message}</div>
            </div>
          );
        }
        // permission — SP-3 dropped the mid-run permission UI (see Conversation).
        return null;
      })}
    </>
  );
}

export function ThinkingBlock({ text, collapsed = false }: { text: string; collapsed?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!collapsed);
  return (
    <div className="msg msg--aux">
      <button className={"thinking" + (open ? " thinking--open" : "")} onClick={() => setOpen(!open)} type="button">
        <span className="thinking__icon">{Icon.brain}</span>
        <span className="thinking__label">{t("chat.blocks.thinking")}</span>
        <span className="thinking__toggle">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="thinking__body">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

export function ToolCallBlock({
  name,
  input,
  result,
  status = "done",
  defaultOpen = false,
}: {
  name: string;
  input: unknown;
  result?: unknown;
  status?: "running" | "done" | "error";
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const inputPreview = toolInputPreview(input);
  const resultText = typeof result === "string" ? result : safeStringify(result);

  return (
    <div className="msg msg--aux">
      <button
        className={"toolcall toolcall--" + status + (open ? " toolcall--open" : "")}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="toolcall__status">
          {status === "running" ? <span className="toolcall__spin">{Icon.refresh}</span> : Icon.tool}
        </span>
        <span className="toolcall__name">{name}</span>
        <span className="toolcall__input">{inputPreview}</span>
        <span className="toolcall__toggle">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="toolcall__body">
          {result === undefined ? (
            <div className="toolcall__result toolcall__result--empty">…</div>
          ) : (
            <pre className="toolcall__result">
              <code>{truncate(resultText, 4096)}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function PermissionPrompt({
  toolName,
  what,
  onAllow,
  onAllowAlways,
  onDeny,
}: {
  toolName: string;
  what: ReactNode;
  onAllow: () => void;
  onAllowAlways?: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="msg msg--aux">
      <div className="perm">
        <div className="perm__head">
          <span className="perm__icon">{Icon.shield}</span>
          <div>
            <div className="perm__title">{t("chat.blocks.permissionNeeded")}</div>
            <div className="perm__sub">
              <code>{toolName}</code> {t("chat.blocks.permissionWant")} {what}
            </div>
          </div>
        </div>
        <div className="perm__actions">
          <button className="btn btn-sm" onClick={onDeny} type="button">{t("chat.blocks.deny")}</button>
          <button className="btn btn-sm btn-primary" onClick={onAllow} type="button">{t("chat.blocks.allowOnce")}</button>
          {onAllowAlways && (
            <button className="btn btn-sm btn-ghost" onClick={onAllowAlways} type="button">
              {t("chat.blocks.allowAlways")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SessionSwitch({ from, to }: { from: string; to: string }) {
  return (
    <div className="session-switch">
      <div className="session-switch__line" />
      <span className="session-switch__text">{from} → {to}</span>
      <div className="session-switch__line" />
    </div>
  );
}

export function FallbackCard({
  offlineHost,
  offlineSince,
  alternatives,
  onSwitch,
  onCancel,
}: {
  offlineHost: string;
  offlineSince: string;
  alternatives: { id: string; name: string; lastSeen: string }[];
  onSwitch: (hostId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState(alternatives[0]?.id ?? "");
  return (
    <div className="msg msg--aux">
      <div className="fallback">
        <div className="fallback__head">
          <span className="fallback__icon">{Icon.bolt}</span>
          <div className="fallback__head-text">
            <div className="fallback__title">{t("chat.blocks.hostOffline", { host: offlineHost })}</div>
            <div className="fallback__sub">{offlineSince}</div>
          </div>
        </div>
        <div className="fallback__body">{t("chat.blocks.switchMachine")}</div>
        <div className="fallback__options">
          {alternatives.map((alt) => (
            <label key={alt.id} className={"fallback__opt" + (picked === alt.id ? " fallback__opt--on" : "")}>
              <input type="radio" name="host" checked={picked === alt.id} onChange={() => setPicked(alt.id)} />
              <span className="dot dot-online" />
              <span className="fallback__opt-name">{alt.name}</span>
              <span className="fallback__opt-sub">· {alt.lastSeen}</span>
            </label>
          ))}
        </div>
        <div className="fallback__note">
          {t("chat.blocks.rebuildNote", { host: offlineHost })}
        </div>
        <div className="fallback__actions">
          <button className="btn btn-sm" onClick={onCancel} type="button">{t("chat.blocks.waitForHost", { host: offlineHost })}</button>
          <button className="btn btn-sm btn-primary" onClick={() => onSwitch(picked)} type="button">{t("chat.blocks.switchAndSend")}</button>
        </div>
      </div>
    </div>
  );
}

export function NoHostBanner({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="no-host">
      <span className="no-host__icon">{Icon.bolt}</span>
      <div className="no-host__body">
        <div className="no-host__title">{t("chat.blocks.noHostTitle")}</div>
        <div className="no-host__sub">{t("chat.blocks.noHostSub")}</div>
      </div>
      {onOpenSettings && <button className="btn btn-sm" onClick={onOpenSettings} type="button">{t("chat.blocks.manageHosts")}</button>}
    </div>
  );
}

