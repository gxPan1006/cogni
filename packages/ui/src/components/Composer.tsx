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
import type { UploadItem } from "../hooks/useUploads.js";
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
  uploads,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  /** Pill above the textarea. Omit to hide the pill entirely. */
  status?: ComposerStatus;
  /** Override the idle textarea placeholder (e.g. orchestrator scope hint). */
  placeholder?: string;
  /** Optional upload tray. When present, the attach button + drag-drop activate. */
  uploads?: {
    items: UploadItem[];
    busy: boolean;
    add: (files: FileList | File[]) => void;
    remove: (localId: string) => void;
    retry: (localId: string) => void;
  };
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Autosize: reset to 0 then read scrollHeight so it grows AND shrinks.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX) + "px";
  }, [draft]);

  const hasText = draft.trim().length > 0;
  const canSubmit = hasText && !disabled && !(uploads?.busy ?? false);

  return (
    <div className={"composer-region" + (disabled ? " composer-region--disabled" : "")}>
      {status && <StatusPill status={status} />}

      <form
        className={"composer" + (hasText ? " composer--has-text" : "")}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit();
        }}
        onDragOver={uploads ? (e) => { e.preventDefault(); } : undefined}
        onDrop={uploads ? (e) => { e.preventDefault(); if (e.dataTransfer.files.length) uploads.add(e.dataTransfer.files); } : undefined}
      >
        {uploads && uploads.items.length > 0 && (
          <div className="composer__attachments">
            {uploads.items.map((it) => (
              <div
                key={it.localId}
                className={"attach-chip" + (it.status === "error" ? " attach-chip--error" : "")}
                title={it.error ?? it.file.name}
              >
                <span className="attach-chip__icon" aria-hidden="true">{Icon.attach}</span>
                <span className="attach-chip__name">{it.name ?? it.file.name}</span>
                <span className="attach-chip__size">{formatBytes(it.size ?? it.file.size)}</span>
                {it.status === "uploading" && (
                  <span className="attach-chip__bar"><span style={{ width: `${Math.round(it.progress * 100)}%` }} /></span>
                )}
                {it.status === "error" && (
                  <button type="button" className="attach-chip__retry" onClick={() => uploads.retry(it.localId)} title="重试">↻</button>
                )}
                <button type="button" className="attach-chip__x" onClick={() => uploads.remove(it.localId)} aria-label="移除附件">✕</button>
              </div>
            ))}
          </div>
        )}

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
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (uploads && e.target.files && e.target.files.length) uploads.add(e.target.files);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
          <button
            type="button"
            className="composer__icon-btn"
            disabled={disabled || !uploads}
            title={uploads ? "添加附件" : "附件功能不可用"}
            aria-label="Attach file"
            onClick={() => fileInputRef.current?.click()}
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
