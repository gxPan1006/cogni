/**
 * Composer — chat input bar with toolbar (attach / model picker / voice / send).
 *
 * Owned by Track B. Visually aligned with the ai-cognit webchat composer block
 * (textarea on top, a single toolbar row underneath: attach · spacer · model
 * pill · mic · send). SP-1 wires the textarea + send to `useThreadStream` via
 * the parent Conversation; attach / mic / model are *disabled placeholders*
 * (SP-2 will activate them).
 *
 * Props shape is the Phase 1 contract — do not change without telling Shell.
 */
import { useEffect, useRef } from "react";
import "./composer.css";

const TEXTAREA_MAX_HEIGHT_PX = 200;

export function Composer({
  draft,
  setDraft,
  onSubmit,
  disabled,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autosize: reset to 0 then read scrollHeight so the textarea grows AND
  // shrinks as content changes. Cap at TEXTAREA_MAX_HEIGHT_PX — past that
  // the internal scrollbar takes over.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX);
    el.style.height = next + "px";
  }, [draft]);

  const hasText = draft.trim().length > 0;
  const canSubmit = hasText && !disabled;

  return (
    <div className={"composer-block" + (disabled ? " composer-block--disabled" : "")}>
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
          placeholder="How can I help you today?"
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
          {/* Attach — SP-2 will wire up file uploads. */}
          <button
            type="button"
            className="icon-btn"
            disabled
            title="附件功能将在 SP-2 版本支持"
            aria-label="Attach file"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          <div className="composer__spacer" />

          {/* Model picker — SP-1 ships a single hard-coded model. */}
          <button
            type="button"
            className="model-btn"
            disabled
            title="模型切换将在后续版本支持"
          >
            <span className="model-btn__name">Opus 4.7</span>
            <span className="badge">Adaptive</span>
            <span className="model-btn__chev" aria-hidden="true">▾</span>
          </button>

          {/* Voice — SP-2 will wire up dictation. */}
          <button
            type="button"
            className="icon-btn"
            disabled
            title="语音输入将在 SP-2 版本支持"
            aria-label="Voice input"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <line x1="12" y1="18" x2="12" y2="22" />
            </svg>
          </button>

          {/* Send — circular accent button, enabled only when there is text. */}
          <button
            type="submit"
            className="icon-btn icon-btn--lg composer__send"
            disabled={!canSubmit}
            title="发送 (Enter)"
            aria-label="Send message"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="20" x2="12" y2="4" />
              <polyline points="5 11 12 4 19 11" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
