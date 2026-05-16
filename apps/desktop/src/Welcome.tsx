/**
 * Welcome — empty-state page shown in the main slot when no thread is active.
 *
 * Owned by Track C (Login + Welcome). Aligned with ai-cognit webchat:
 *   ✳ Good morning / afternoon / evening (+ userName when available)
 *   [Composer]
 *   [ Write · Learn · Code · Life stuff · Surprise me — Cogni's choice ]
 *
 * Behaviour the user sees:
 *   - On mount, the greeting auto-picks a salutation by local time of day
 *     (mirrors ai-cognit's greeting.js: 0–5 "Hello, night owl",
 *     5–12 "Good morning", 12–18 "Good afternoon", 18–22 "Good evening",
 *     22–24 "Hello, night owl"). If `userName` is provided (reserved hook for
 *     SP-2 once /api/me lands), it's appended after a comma.
 *   - The Composer sits directly underneath, pre-focused via its own
 *     textarea defaults. Typing then Enter (or 发送) calls `onStartChat(text)`
 *     which spawns a brand-new thread.
 *   - Below the composer, five quick-prompt chips. Clicking a chip prefills
 *     the composer draft with the seed phrase (e.g. "Write" → "Help me write ")
 *     so the cursor lands ready for the user to keep typing. It does NOT
 *     auto-send — same UX as ai-cognit and Claude.com.
 *   - Pure presentation: the chip click flow stays inside this component's
 *     local `draft` state, so the Composer/Conversation contract is unchanged.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Composer } from "./Composer.js";
import "./welcome.css";

type Chip = {
  prompt: string;
  label: string;
  icon: ReactNode;
};

const CHIPS: Chip[] = [
  {
    prompt: "Help me write ",
    label: "Write",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      </svg>
    ),
  },
  {
    prompt: "Explain to me how ",
    label: "Learn",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M22 10L12 5 2 10l10 5 10-5z" />
        <path d="M6 12v5c0 2 3 3 6 3s6-1 6-3v-5" />
      </svg>
    ),
  },
  {
    prompt: "Write code that ",
    label: "Code",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    prompt: "I need help with ",
    label: "Life stuff",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 11h14a3 3 0 0 1 0 6h-1" />
        <path d="M4 11v7a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1" />
        <line x1="7" y1="4" x2="7" y2="8" />
        <line x1="11" y1="4" x2="11" y2="8" />
        <line x1="15" y1="4" x2="15" y2="8" />
      </svg>
    ),
  },
  {
    prompt: "Surprise me — ",
    label: "Surprise me — Cogni's choice",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
      </svg>
    ),
  },
];

// Mirrors ai-cognit's greeting.js. Hour buckets:
//   0–5  → "Hello, night owl"
//   5–12 → "Good morning"
//   12–18 → "Good afternoon"
//   18–22 → "Good evening"
//   22–24 → "Hello, night owl"
function pickSalutation(now: Date): { lead: string; coda: string } {
  const hour = now.getHours();
  if (hour < 5) return { lead: "Hello", coda: "night owl" };
  if (hour < 12) return { lead: "Good morning", coda: "" };
  if (hour < 18) return { lead: "Good afternoon", coda: "" };
  if (hour < 22) return { lead: "Good evening", coda: "" };
  return { lead: "Hello", coda: "night owl" };
}

function buildGreeting(userName?: string): string {
  const { lead, coda } = pickSalutation(new Date());
  // Prefer userName when we have it (SP-2 hook); otherwise fall back to the
  // generic time-of-day greeting (with the "night owl" coda outside 5–22).
  if (userName) return `${lead}, ${userName}`;
  if (coda) return `${lead}, ${coda}`;
  return lead;
}

export function Welcome({
  userName,
  onStartChat,
}: {
  userName?: string;
  onStartChat: (firstMessage: string) => void;
}) {
  const [draft, setDraft] = useState("");

  // Compute once per mount — no need to re-tick on the second; if the user
  // sits on the empty state through midnight the salutation will refresh on
  // their next chat / app reopen.
  const greeting = useMemo(() => buildGreeting(userName), [userName]);

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__greeting">
          <span className="welcome__star" aria-hidden="true">
            ✳
          </span>
          <span>{greeting}</span>
        </h1>

        <div className="welcome__composer-block">
          <Composer
            draft={draft}
            setDraft={setDraft}
            onSubmit={() => {
              if (!draft.trim()) return;
              onStartChat(draft);
              setDraft("");
            }}
          />

          <div className="welcome__chips" role="list">
            {CHIPS.map((chip) => (
              <button
                key={chip.label}
                type="button"
                className="welcome__chip"
                role="listitem"
                onClick={() => setDraft(chip.prompt)}
              >
                <span className="welcome__chip-icon" aria-hidden="true">
                  {chip.icon}
                </span>
                <span>{chip.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
