/**
 * Composer — chat input bar with autosize textarea + toolbar row.
 *
 * Props shape is the Phase 1 contract — do not change without telling Shell.
 *
 * Visual changes vs SP-1 spike:
 *   - host-online chip floats above the input
 *   - send button is a small square accent button (Enter still primary)
 *   - attach / model picker stay disabled placeholders for now
 */
import { useEffect, useRef } from "react";
import { Icon } from "./icons.js";
import "./composer.css";

const TEXTAREA_MAX_HEIGHT_PX = 200;

export function Composer({
  draft,
  setDraft,
  onSubmit,
  disabled,
  hostName,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  /** Optional host chip — pass the name of the host this thread will run on. */
  hostName?: string;
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
      {hostName && (
        <div className="composer-host">
          <span className="dot dot-online" />
          <span className="composer-host__label">RUNNING ON</span>
          <span className="composer-host__name">{hostName}</span>
        </div>
      )}

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
          placeholder={disabled ? "等待重连…" : "想聊点什么?"}
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
