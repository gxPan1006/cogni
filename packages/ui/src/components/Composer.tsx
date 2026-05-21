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
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RunnerCommandId } from "@cogni/contract";
import { Icon } from "./icons.js";
import type { UploadItem } from "../hooks/useUploads.js";
import { AttachmentCard } from "./AttachmentCard.js";
import { ModelSelector } from "./ModelSelector.js";
import "./composer.css";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|heic|bmp|avif)$/i;

/** One upload item rendered as an AttachmentCard, owning its image preview URL. */
function ComposerAttachment({
  item,
  onRemove,
  onRetry,
}: {
  item: UploadItem;
  onRemove: () => void;
  onRetry: () => void;
}) {
  // Image files get an inline thumbnail from the local File (revoked on unmount).
  const previewUrl = useMemo(
    () => (IMAGE_RE.test(item.file.name) ? URL.createObjectURL(item.file) : undefined),
    [item.file],
  );
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  return (
    <AttachmentCard
      name={item.name ?? item.file.name}
      size={item.size ?? item.file.size}
      previewUrl={previewUrl}
      progress={item.progress}
      status={item.status}
      error={item.error}
      onRemove={onRemove}
      onRetry={onRetry}
    />
  );
}

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
  onPrewarm,
  disabled,
  status,
  placeholder,
  uploads,
  models,
  model,
  onModelChange,
  streaming,
  onStop,
  commands,
  onRunCommand,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  /**
   * Fired when the user focuses the composer (intent to type). The caller uses
   * it to prewarm the runner process so the first token isn't gated on the CLI
   * cold start. Cheap + idempotent downstream, so firing on every focus is fine.
   */
  onPrewarm?: () => void;
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
  /** Model picker. When provided, replaces the static "claude-code" label. */
  models?: readonly { id: string; label: string }[];
  model?: string;
  onModelChange?: (id: string) => void;
  /** A turn is in flight → the send button (↑) becomes a stop button (■). */
  streaming?: boolean;
  /** Called when the user clicks the stop button. */
  onStop?: () => void;
  /** Runner commands available for this thread's adapter (the "/" menu). */
  commands?: readonly RunnerCommandId[];
  /** Called with the chosen command when the user picks one from the "/" menu. */
  onRunCommand?: (command: RunnerCommandId) => void;
}) {
  const { t } = useTranslation();
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

  // Slash command menu: open while the draft is a bare "/<query>" and the
  // thread's adapter advertises commands. Filtered by id or localized label.
  const availableCommands = commands ?? [];
  const slashQuery = draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n")
    ? draft.slice(1).toLowerCase()
    : null;
  const menuItems = useMemo(() => {
    if (slashQuery === null || availableCommands.length === 0) return [];
    return availableCommands.filter(
      (c) => c.includes(slashQuery) || t(`chat.composer.commands.${c}`).toLowerCase().includes(slashQuery),
    );
  }, [slashQuery, availableCommands, t]);
  const menuOpen = menuItems.length > 0;
  const [menuIndex, setMenuIndex] = useState(0);
  // Keep the highlighted row in range as the filter narrows.
  useEffect(() => { setMenuIndex(0); }, [slashQuery]);

  const pickCommand = (command: RunnerCommandId) => {
    onRunCommand?.(command);
    setDraft("");
  };

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
          <div className="att-tray composer__att-tray">
            {uploads.items.map((it) => (
              <ComposerAttachment
                key={it.localId}
                item={it}
                onRemove={() => uploads.remove(it.localId)}
                onRetry={() => uploads.retry(it.localId)}
              />
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="composer__input"
          value={draft}
          placeholder={disabled ? t("chat.composer.placeholderDisabled") : (placeholder ?? t("chat.composer.placeholder"))}
          rows={1}
          disabled={disabled}
          onFocus={onPrewarm ? () => onPrewarm() : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={
            uploads
              ? (e) => {
                  // Cmd+V a screenshot / copied file → attach it, mirroring the
                  // drag-drop path. Only swallow the paste when the clipboard
                  // actually carries files; plain text paste falls through.
                  const files = e.clipboardData?.files;
                  if (files && files.length > 0) {
                    e.preventDefault();
                    uploads.add(files);
                  }
                }
              : undefined
          }
          onKeyDown={(e) => {
            // While the "/" menu is open, arrows + Enter drive it (not the textarea).
            if (menuOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMenuIndex((i) => (i + 1) % menuItems.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const cmd = menuItems[menuIndex];
                if (cmd) pickCommand(cmd);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft("");
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSubmit) onSubmit();
            }
          }}
        />

        {menuOpen && (
          <ul className="composer__slash-menu" role="listbox" aria-label="commands">
            {menuItems.map((c, i) => (
              <li key={c} role="option" aria-selected={i === menuIndex}>
                <button
                  type="button"
                  className={"composer__slash-item" + (i === menuIndex ? " composer__slash-item--active" : "")}
                  // mousedown (not click) so it fires before the textarea blur.
                  onMouseDown={(e) => { e.preventDefault(); pickCommand(c); }}
                  onMouseEnter={() => setMenuIndex(i)}
                >
                  <span className="composer__slash-cmd">/{c}</span>
                  <span className="composer__slash-label">{t(`chat.composer.commands.${c}`)}</span>
                  <span className="composer__slash-hint">{t(`chat.composer.commands.${c}Hint`)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

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
            title={uploads ? t("chat.composer.attach") : t("chat.composer.attachUnavailable")}
            aria-label={t("chat.composer.attachAria")}
            onClick={() => fileInputRef.current?.click()}
          >
            {Icon.attach}
          </button>

          <div className="composer__spacer" />

          {models && model && onModelChange ? (
            <ModelSelector models={models} value={model} onChange={onModelChange} disabled={disabled} />
          ) : (
            <span className="composer__model">claude-code</span>
          )}

          {streaming ? (
            <button
              type="button"
              className="composer__send composer__send--stop"
              onClick={() => onStop?.()}
              title={t("chat.composer.stop")}
              aria-label={t("chat.composer.stopAria")}
            >
              {Icon.stop}
            </button>
          ) : (
            <button
              type="submit"
              className="composer__send"
              disabled={!canSubmit}
              title={t("chat.composer.send")}
              aria-label={t("chat.composer.sendAria")}
            >
              {Icon.send}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function StatusPill({ status }: { status: ComposerStatus }) {
  const { t } = useTranslation();
  if (status.kind === "ok") {
    return (
      <div className="status-pill status-pill--ok" role="status">
        <span className="status-pill__dot" aria-hidden="true" />
        <span className="status-pill__label">{t("chat.composer.runningOn")}</span>
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
