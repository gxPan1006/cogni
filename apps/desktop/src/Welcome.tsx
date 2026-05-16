/**
 * Welcome — empty-state page shown in the main slot when no thread is active.
 *
 * Owned by Track C (Login + Welcome). Aligned with ai-cognit webchat:
 *   ✳ Hello {name}
 *   [Composer with chips below: Write / Learn / Code / Life stuff / Surprise]
 *
 * Stub created in Phase 1. Track C fills the greeting + chips. The composer is
 * embedded directly here so the empty state already has a place to type — same
 * UX as ai-cognit and Claude. `onSubmit(text)` should call the same path used
 * by + New chat → first message, so a brand-new conversation appears.
 */
import { useState } from "react";
import { Composer } from "./Composer.js";
import "./welcome.css";

export function Welcome({
  userName,
  onStartChat,
}: {
  userName?: string;
  onStartChat: (firstMessage: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="welcome">
      <h1 className="welcome__greeting">
        <span className="welcome__star">✳</span>
        <span>Hello{userName ? `, ${userName}` : ""}</span>
      </h1>
      <Composer
        draft={draft}
        setDraft={setDraft}
        onSubmit={() => {
          if (!draft.trim()) return;
          onStartChat(draft);
          setDraft("");
        }}
      />
      {/* Track C: add chips here (Write / Learn / Code / Life stuff / Surprise me) */}
    </div>
  );
}
