/**
 * TaskComments — the 主页面 comment feed card grid.
 *
 * Worker handoff cards (sparkle icon + a state chip like "→ 完成") and human
 * comment cards (user icon + a delete affordance on own un-consumed cards)
 * wrap in a CSS grid, chronological. A trailing dashed "+" card opens an
 * inline composer; submitting appends a human card (inert server-side, lands
 * via the WS echo). The empty state shows just the "+" card with hint text.
 */
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TaskComment } from "@cogni/contract";
import type { ApiClient } from "../../transport/api.js";
import { useTaskComments } from "../../hooks/useTaskComments.js";
import { useUploads, type UseUploads } from "../../hooks/useUploads.js";
import { AttachmentCard } from "../AttachmentCard.js";
import { Markdown } from "../Markdown.js";
import { Icon } from "../icons.js";
import { STATE_COLOR } from "./ProjectBoard.js";

const STATE_CHIP_KEY: Record<string, string> = {
  done: "project.comments.chipDone",
  reviewing: "project.comments.chipReviewing",
  "needs-input": "project.comments.chipNeedsInput",
  running: "project.comments.chipRunning",
  queued: "project.comments.chipQueued",
  failed: "project.comments.chipFailed",
  cancelled: "project.comments.chipCancelled",
};

/** Localized worker-handoff state chip ("→ Done" etc.), falling back to the raw state. */
function stateChip(t: TFunction, state: string): string {
  const key = STATE_CHIP_KEY[state];
  return key ? t(key) : state;
}

export function TaskComments({ api, taskId }: { api: ApiClient; taskId: string }) {
  const { t } = useTranslation();
  const { comments, loading, add, remove } = useTaskComments(api, taskId);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  // Card opened into the full-markdown detail modal (null = closed).
  const [openComment, setOpenComment] = useState<TaskComment | null>(null);
  // Reuse the chat upload pipeline: files stage on the task's host under its
  // executionThreadId; their names ride the comment and get materialized into
  // the worktree at the next run. (Upload 409s if the task hasn't started.)
  const uploads = useUploads((file, onProgress) => api.uploadTaskFile(taskId, file, onProgress));

  const submit = () => {
    const text = draft.trim();
    if (!text || uploads.busy) return;
    const attachments = uploads.takeAttachments();
    setDraft("");
    setAdding(false);
    uploads.reset();
    void add(text, attachments);
  };

  const cancel = () => {
    setDraft("");
    setAdding(false);
    uploads.reset();
  };

  return (
    <section className="tc">
      <div className="tc__head">{t("project.comments.head")}</div>
      <div className="tc__grid">
        {comments.map((c) => (
          <CommentCard key={c.id} comment={c} onDelete={() => void remove(c.id)} onOpen={() => setOpenComment(c)} />
        ))}
        {adding ? (
          <CommentComposer draft={draft} setDraft={setDraft} onSubmit={submit} onCancel={cancel} uploads={uploads} />
        ) : (
          <button className="tc__card tc__card--add" onClick={() => setAdding(true)}>
            <span className="tc__add-plus">{Icon.plus}</span>
            <span className="tc__add-hint">
              {comments.length === 0 && !loading ? t("project.comments.addHintEmpty") : t("project.comments.addHint")}
            </span>
          </button>
        )}
      </div>
      {openComment && <CommentDetailModal comment={openComment} onClose={() => setOpenComment(null)} />}
    </section>
  );
}

/**
 * Inline comment composer — a borderless auto-growing textarea inside the card
 * itself (no nested box), an attach button + thumbnail tray, a quiet keyboard
 * hint, and a small send button. Deliberately NOT the chat <Composer>: a
 * comment has no model picker, so that affordance is dropped. Files reuse the
 * task upload pipeline. Enter submits, Esc cancels; drag-drop also attaches.
 */
function CommentComposer({
  draft, setDraft, onSubmit, onCancel, uploads,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  uploads: UseUploads;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Focus on open, then autosize (reset to auto so it grows AND shrinks).
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [draft]);

  const canSubmit = draft.trim().length > 0 && !uploads.busy;
  return (
    <div
      className="tc__card tc__card--compose"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) uploads.add(e.dataTransfer.files); }}
    >
      {uploads.items.length > 0 && (
        <div className="tc__compose-tray">
          {uploads.items.map((it) => (
            <AttachmentCard
              key={it.localId}
              name={it.name ?? it.file.name}
              size={it.size ?? it.file.size}
              progress={it.progress}
              status={it.status}
              error={it.error}
              onRemove={() => uploads.remove(it.localId)}
              onRetry={() => uploads.retry(it.localId)}
            />
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="tc__compose-input"
        value={draft}
        rows={2}
        placeholder={t("project.comments.composePlaceholder")}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSubmit) onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => { if (e.target.files?.length) uploads.add(e.target.files); e.target.value = ""; }}
      />
      <div className="tc__compose-foot">
        <div className="tc__compose-left">
          <button
            type="button"
            className="tc__compose-attach"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            title={t("project.comments.attach")}
            aria-label={t("project.comments.attach")}
          >
            {Icon.attach}
          </button>
          <span className="tc__compose-hint">{t("project.comments.composeHint")}</span>
        </div>
        <button
          type="button"
          className="tc__compose-send"
          disabled={!canSubmit}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSubmit}
          title={t("project.comments.sendTitle")}
          aria-label={t("project.comments.send")}
        >
          {Icon.send}
        </button>
      </div>
    </div>
  );
}

function CommentCard({ comment, onDelete, onOpen }: { comment: TaskComment; onDelete: () => void; onOpen: () => void }) {
  const { t } = useTranslation();
  const isWorker = comment.author === "worker";
  return (
    <div
      className={"tc__card tc__card--clickable" + (isWorker ? " tc__card--worker" : " tc__card--user")}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      title={t("project.comments.cardOpenTitle")}
    >
      <div className="tc__card-head">
        <span className="tc__avatar">{isWorker ? Icon.spark : Icon.user}</span>
        {isWorker && (
          <span className="tc__chip" style={{ color: STATE_COLOR[comment.state] }}>
            {stateChip(t, comment.state)}
          </span>
        )}
        {!isWorker && comment.consumedByRunId && <span className="tc__badge">{t("project.comments.delivered")}</span>}
        {!isWorker && !comment.consumedByRunId && (
          <button
            className="tc__del"
            title={t("project.comments.delete")}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            {Icon.x}
          </button>
        )}
      </div>
      {/* Clamped preview — full markdown lives in the detail modal on click. */}
      <div className="tc__card-body tc__card-body--clamp"><Markdown text={comment.body} /></div>
      {comment.attachments && comment.attachments.length > 0 && (
        <div className="tc__card-atts">
          {comment.attachments.map((a) => (
            <AttachmentCard key={a.name} name={a.name} size={a.size} status="done" />
          ))}
        </div>
      )}
      <time className="tc__time">{formatAgo(comment.createdAt)}</time>
    </div>
  );
}

/**
 * Full-content modal for one comment — opens on card click, renders the body as
 * Markdown (cards only show a clamped preview). Sits above the TaskDetail modal;
 * its Escape listener captures + stops propagation so closing it doesn't also
 * close the parent task panel.
 */
function CommentDetailModal({ comment, onClose }: { comment: TaskComment; onClose: () => void }) {
  const { t } = useTranslation();
  const isWorker = comment.author === "worker";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true); // capture: preempt TaskDetail's Esc
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="tcd-scrim" onClick={onClose}>
      <div className="tcd" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="tcd__head">
          <span className="tcd__who">
            <span className="tc__avatar">{isWorker ? Icon.spark : Icon.user}</span>
            {isWorker
              ? <span className="tc__chip" style={{ color: STATE_COLOR[comment.state] }}>{stateChip(t, comment.state)}</span>
              : <span className="tcd__who-label">{t("project.comments.humanNote")}</span>}
            <time className="tcd__time">{formatAgo(comment.createdAt)}</time>
          </span>
          <button className="td__icon-btn" onClick={onClose} title={t("project.comments.detailClose")} aria-label={t("project.comments.detailClose")}>{Icon.x}</button>
        </div>
        <div className="tcd__body"><Markdown text={comment.body} /></div>
        {comment.attachments && comment.attachments.length > 0 && (
          <div className="tcd__atts">
            {comment.attachments.map((a) => (
              <AttachmentCard key={a.name} name={a.name} size={a.size} status="done" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
