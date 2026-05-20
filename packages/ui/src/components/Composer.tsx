/**
 * Composer — chat input bar with autosize textarea + toolbar row.
 *
 * Status pill above the textarea is the single source of truth for
 * connection / host state (the top-of-conversation banner is gone). The
 * caller computes a `ComposerStatus` from its hooks and passes it in;
 * undefined means "render no pill" (e.g. Welcome before a thread exists).
 *
 * Other visual notes:
 *   - send button is a small square accent button (Enter still primary)
 *   - attach / model picker stay disabled placeholders for now
 */
import { useEffect, useRef } from "react";
import { Icon } from "./icons.js";
import "./composer.css";

const TEXTAREA_MAX_HEIGHT_PX = 200;

/**
 * Connection / host state to surface in the composer status pill.
 *   - `ok`     neutral chip with green halo dot + "RUNNING ON <hostName>"
 *   - `warn`   amber chip + "<hostName> <text>" (e.g. "离线 · 等待上线")
 *   - `danger` red chip with pulsing dot + free-form text
 */
export type ComposerStatus =
  | { kind: "ok"; hostName: string }
  | { kind: "warn"; hostName: string; text: string }
  | { kind: "danger"; text: string };

export function Composer({
  draft,
  setDraft,
  onSubmit,
  disabled,
  status,
  placeholder,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  /** Pill above the textarea. Omit to hide the pill entirely. */
  status?: ComposerStatus;
  /** Override the idle textarea placeholder (e.g. orchestrator scope hint). */
  placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autosize: reset to 0 then read scrollHeight so it grows AND shrinks.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX) + "px";
  }, [draft]);

  const hasText = draft.trim().length > 0;
  const canSubmit = hasText && !disabled;

  return (
    <div className={"composer-region" + (disabled ? " composer-region--disabled" : "")}>
      {status && <StatusPill status={status} />}

      <form
        className={"composer" + (hasText ? " composer--has-text" : "")}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit();
        }}
      >
        <textarea
          ref={textareaRef}
          className="composer__input"
          value={draft}
          placeholder={disabled ? "等待重连…" : (placeholder ?? "想聊点什么?")}
          rows={1}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSubmit) onSubmit();
            }
          }}
        />

        <div className="composer__bar">
          <button
            type="button"
            className="composer__icon-btn"
            disabled
            title="附件功能将在 SP-2 版本支持"
            aria-label="Attach file"
          >
            {Icon.attach}
          </button>

          <div className="composer__spacer" />

          <span className="composer__model">claude-code</span>

          <button
            type="submit"
            className="composer__send"
            disabled={!canSubmit}
            title="发送 (Enter)"
            aria-label="Send message"
          >
            {Icon.send}
          </button>
        </div>
      </form>
    </div>
  );
}

function StatusPill({ status }: { status: ComposerStatus }) {
  if (status.kind === "ok") {
    return (
      <div className="status-pill status-pill--ok" role="status">
        <span className="status-pill__dot" aria-hidden="true" />
        <span className="status-pill__label">RUNNING ON</span>
        <span className="status-pill__name">{status.hostName}</span>
      </div>
    );
  }
  if (status.kind === "warn") {
    return (
      <div className="status-pill status-pill--warn" role="status">
        <span className="status-pill__dot" aria-hidden="true" />
        <span className="status-pill__name">{status.hostName}</span>
        <span className="status-pill__text">{status.text}</span>
      </div>
    );
  }
  return (
    <div className="status-pill status-pill--danger" role="status">
      <span className="status-pill__dot status-pill__dot--pulse" aria-hidden="true" />
      <span className="status-pill__text">{status.text}</span>
    </div>
  );
}
