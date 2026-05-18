/**
 * Welcome — empty-state page shown in the main slot when no thread is active.
 *
 * Keeps the same props and quick-prompt chip semantics as the SP-1 spike.
 * Visual rewrite:
 *   - Large display greeting at top, time-of-day aware (same buckets as before)
 *   - Subtitle hints at the routing — "Cogni will route to <preferred host>"
 *   - Composer reused with optional host name pill
 *   - Quick prompts as soft outlined chips
 */
import { useMemo, useState } from "react";
import { Composer } from "./Composer.js";
import { Icon } from "./icons.js";
import "./welcome.css";

const CHIPS = [
  { prompt: "帮我写 ",   label: "写作",   icon: Icon.edit },
  { prompt: "给我讲讲 ", label: "学习",   icon: Icon.file },
  { prompt: "写一段代码 ", label: "编程", icon: Icon.tool },
  { prompt: "帮我处理 ", label: "生活",   icon: Icon.spark },
  { prompt: "随便聊 ",   label: "随便聊", icon: Icon.bolt },
];

function pickSalutation(now: Date): { lead: string; coda: string } {
  const hour = now.getHours();
  if (hour < 5)  return { lead: "Hello", coda: "night owl" };
  if (hour < 12) return { lead: "Good morning", coda: "" };
  if (hour < 18) return { lead: "Good afternoon", coda: "" };
  if (hour < 22) return { lead: "Good evening", coda: "" };
  return { lead: "Hello", coda: "night owl" };
}

function buildGreeting(userName?: string): string {
  const { lead, coda } = pickSalutation(new Date());
  if (userName) return `${lead}, ${userName}`;
  if (coda) return `${lead}, ${coda}`;
  return lead;
}

export function Welcome({
  userName,
  hostName,
  onStartChat,
}: {
  userName?: string;
  /** Optional: the host this welcome will route to once you send. */
  hostName?: string;
  onStartChat: (firstMessage: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const greeting = useMemo(() => buildGreeting(userName), [userName]);

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <div className="welcome__eyebrow">{greeting.toUpperCase()}</div>
        <h1 className="welcome__greeting">今天想做点什么?</h1>
        {hostName && (
          <div className="welcome__subtitle">
            Cogni 会把任务交给 <strong>{hostName}</strong> — 你最近用的那台。
          </div>
        )}

        <div className="welcome__composer-block">
          <Composer
            draft={draft}
            setDraft={setDraft}
            onSubmit={() => {
              if (!draft.trim()) return;
              onStartChat(draft);
              setDraft("");
            }}
            status={hostName ? { kind: "ok", hostName } : undefined}
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
                <span className="welcome__chip-icon">{chip.icon}</span>
                <span>{chip.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
