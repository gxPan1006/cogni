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
import { useCallback, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Composer } from "./Composer.js";
import { Icon } from "./icons.js";
import { useUploads } from "../hooks/useUploads.js";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";
import "./welcome.css";

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
  api,
}: {
  userName?: string;
  /** Optional: the host this welcome will route to once you send. */
  hostName?: string;
  /**
   * Start the first turn. `opts.threadId` is set when the user attached files:
   * Welcome lazily created that thread (so uploads had somewhere to land), and
   * the caller should navigate to it instead of creating a fresh one. `opts.
   * attachments` are the committed uploads to send with the first message.
   */
  onStartChat: (
    firstMessage: string,
    opts?: { threadId?: string; attachments?: { name: string; size: number }[]; model?: string },
  ) => void;
  /** Needed so attachments can target a thread before the first message is sent. */
  api: ApiClient;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<string>(DEFAULT_CHAT_MODEL);
  const greeting = useMemo(() => buildGreeting(userName), [userName]);

  const chips = useMemo(
    () => [
      { prompt: t("chat.welcome.chips.writingPrompt"),  label: t("chat.welcome.chips.writingLabel"),  icon: Icon.edit },
      { prompt: t("chat.welcome.chips.learningPrompt"), label: t("chat.welcome.chips.learningLabel"), icon: Icon.file },
      { prompt: t("chat.welcome.chips.codingPrompt"),   label: t("chat.welcome.chips.codingLabel"),   icon: Icon.tool },
      { prompt: t("chat.welcome.chips.lifePrompt"),     label: t("chat.welcome.chips.lifeLabel"),     icon: Icon.spark },
      { prompt: t("chat.welcome.chips.casualPrompt"),   label: t("chat.welcome.chips.casualLabel"),   icon: Icon.bolt },
    ],
    [t],
  );

  // First-message attachments need a thread to upload into, but Welcome has no
  // thread yet. Lazily create one the first time the user attaches a file (no
  // navigation — that would unmount Welcome and lose the draft). The created id
  // is handed to onStartChat so the caller navigates to that same thread.
  const threadIdRef = useRef<string | null>(null);
  const ensureThread = useCallback(async () => {
    if (!threadIdRef.current) {
      const t = await api.createThread();
      threadIdRef.current = t.id;
    }
    return threadIdRef.current;
  }, [api]);
  const uploads = useUploads(async (file, onProgress) => {
    const tid = await ensureThread();
    return api.uploadFile(tid, file, onProgress);
  });

  const submit = () => {
    if (!draft.trim()) return;
    const attachments = uploads.takeAttachments();
    onStartChat(draft, { threadId: threadIdRef.current ?? undefined, attachments, model });
    setDraft("");
  };

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <div className="welcome__eyebrow">{greeting.toUpperCase()}</div>
        <h1 className="welcome__greeting">{t("chat.welcome.greeting")}</h1>
        {hostName && (
          <div className="welcome__subtitle">
            <Trans
              i18nKey="chat.welcome.routeTo"
              values={{ hostName }}
              components={[<strong key="host" />]}
            />
          </div>
        )}

        <div className="welcome__composer-block">
          {/* Attachments are supported on the first message: the upload tray
              lazily creates a thread to land files in, then onStartChat routes
              there. */}
          <Composer
            draft={draft}
            setDraft={setDraft}
            onSubmit={submit}
            uploads={uploads}
            models={CHAT_MODELS}
            model={model}
            onModelChange={setModel}
            status={hostName ? { kind: "ok", hostName } : undefined}
          />

          <div className="welcome__chips" role="list">
            {chips.map((chip) => (
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
