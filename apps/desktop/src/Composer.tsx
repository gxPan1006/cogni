/**
 * Composer — chat input bar with toolbar (attach / model picker / voice / send).
 *
 * Owned by Track B (Conversation + Composer). Aligned visually with
 * ai-cognit webchat composer. SP-1 wires: the textarea + send button to the
 * `useThreadStream` hook in Conversation. Attach / voice / model picker are
 * "coming soon" stubs in SP-1 — clicking them toasts.
 *
 * Stub created in Phase 1. Track B fills in the markup and CSS.
 */
import "./composer.css";

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
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <textarea
        className="composer__input"
        value={draft}
        placeholder="How can I help you today?"
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!disabled) onSubmit();
          }
        }}
      />
      {/* Track B: add composer__bar with attach / model / voice / send buttons */}
      <div className="composer__bar">
        <button type="submit" className="btn-primary" disabled={disabled}>
          发送
        </button>
      </div>
    </form>
  );
}
