/**
 * TaskComments — the 主页面 comment feed card grid.
 *
 * Worker handoff cards (sparkle icon + a state chip like "→ 完成") and human
 * comment cards (user icon + a delete affordance on own un-consumed cards)
 * wrap in a CSS grid, chronological. A trailing dashed "+" card opens an
 * inline composer; submitting appends a human card (inert server-side, lands
 * via the WS echo). The empty state shows just the "+" card with hint text.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TaskComment, CommentAttachment } from "@cogni/contract";
import type { ApiClient } from "../../transport/api.js";
import { useTaskComments } from "../../hooks/useTaskComments.js";
import { useUploads, type UseUploads } from "../../hooks/useUploads.js";
import { AttachmentCard } from "../AttachmentCard.js";
import { Markdown } from "../Markdown.js";
import { Icon } from "../icons.js";
import { STATE_COLOR } from "./ProjectBoard.js";
import "./artifacts.css";

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

/** Short single-line preview of a comment body, for reply references/banners. */
function preview(body: string, n = 28): string {
  const s = body.trim().replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function TaskComments({ api, taskId }: { api: ApiClient; taskId: string }) {
  const { t } = useTranslation();
  const { comments, loading, add, remove } = useTaskComments(api, taskId);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  // Card opened into the full-markdown detail modal (null = closed).
  const [openComment, setOpenComment] = useState<TaskComment | null>(null);
  // Attachment opened into the preview/download modal (null = closed).
  const [preview, setPreview] = useState<{ comment: TaskComment; att: CommentAttachment } | null>(null);
  // The card this draft is replying to (null = top-level note).
  const [replyingTo, setReplyingTo] = useState<TaskComment | null>(null);
  // Briefly highlights a card when its reply-reference is clicked.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Reuse the chat upload pipeline: files stage on the task's host under its
  // executionThreadId; their names ride the comment and get materialized into
  // the worktree at the next run. (Upload 409s if the task hasn't started.)
  const uploads = useUploads((file, onProgress) => api.uploadTaskFile(taskId, file, onProgress));

  const commentsById = new Map(comments.map((c) => [c.id, c]));

  const submit = () => {
    const text = draft.trim();
    if (!text || uploads.busy) return;
    const attachments = uploads.takeAttachments();
    const parentId = replyingTo?.id;
    setDraft("");
    setAdding(false);
    setReplyingTo(null);
    uploads.reset();
    void add(text, attachments, parentId);
  };

  const cancel = () => {
    setDraft("");
    setAdding(false);
    setReplyingTo(null);
    uploads.reset();
  };

  const startReply = (c: TaskComment) => {
    setOpenComment(null);
    setReplyingTo(c);
    setAdding(true);
  };

  const jumpTo = (id: string) => {
    setHighlightId(id);
    document.getElementById(`tc-card-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 1400);
  };

  return (
    <section className="tc">
      <div className="tc__head">{t("project.comments.head")}</div>
      <div className="tc__grid">
        {comments.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            parent={c.parentCommentId ? commentsById.get(c.parentCommentId) : undefined}
            highlighted={highlightId === c.id}
            onDelete={() => void remove(c.id)}
            onOpen={() => setOpenComment(c)}
            onReply={() => startReply(c)}
            onJumpToParent={jumpTo}
            onOpenAttachment={(att) => setPreview({ comment: c, att })}
          />
        ))}
        {adding ? (
          <CommentComposer
            draft={draft}
            setDraft={setDraft}
            onSubmit={submit}
            onCancel={cancel}
            uploads={uploads}
            replyingTo={replyingTo}
            onClearReply={() => setReplyingTo(null)}
          />
        ) : (
          <button className="tc__card tc__card--add" onClick={() => setAdding(true)}>
            <span className="tc__add-plus">{Icon.plus}</span>
            <span className="tc__add-hint">
              {comments.length === 0 && !loading ? t("project.comments.addHintEmpty") : t("project.comments.addHint")}
            </span>
          </button>
        )}
      </div>
      {openComment && (
        <CommentDetailModal
          comment={openComment}
          parent={openComment.parentCommentId ? commentsById.get(openComment.parentCommentId) : undefined}
          onClose={() => setOpenComment(null)}
          onReply={() => startReply(openComment)}
          onOpenAttachment={(att) => setPreview({ comment: openComment, att })}
        />
      )}
      {preview && (
        <AttachmentPreview
          api={api}
          taskId={taskId}
          commentId={preview.comment.id}
          att={preview.att}
          onClose={() => setPreview(null)}
        />
      )}
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
  draft, setDraft, onSubmit, onCancel, uploads, replyingTo, onClearReply,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  uploads: UseUploads;
  replyingTo: TaskComment | null;
  onClearReply: () => void;
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
      {replyingTo && (
        <div className="tc__reply-banner">
          <span className="tc__reply-banner-text">
            ↩ {t("project.comments.replyingTo", { text: preview(replyingTo.body) })}
          </span>
          <button type="button" className="tc__reply-banner-x" onClick={onClearReply} aria-label={t("project.comments.cancelReply")}>{Icon.x}</button>
        </div>
      )}
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

function CommentCard({
  comment, parent, highlighted, onDelete, onOpen, onReply, onJumpToParent, onOpenAttachment,
}: {
  comment: TaskComment;
  parent: TaskComment | undefined;
  highlighted: boolean;
  onDelete: () => void;
  onOpen: () => void;
  onReply: () => void;
  onJumpToParent: (id: string) => void;
  onOpenAttachment: (att: CommentAttachment) => void;
}) {
  const { t } = useTranslation();
  const isWorker = comment.author === "worker";
  return (
    <div
      id={`tc-card-${comment.id}`}
      className={"tc__card tc__card--clickable" + (isWorker ? " tc__card--worker" : " tc__card--user") + (highlighted ? " tc__card--flash" : "")}
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
        <div className="tc__card-actions">
          <button
            className="tc__reply-btn"
            title={t("project.comments.reply")}
            aria-label={t("project.comments.reply")}
            onClick={(e) => { e.stopPropagation(); onReply(); }}
          >
            ↩
          </button>
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
      </div>
      {/* Reply reference — click to jump to + flash the parent card. */}
      {comment.parentCommentId && (
        <button
          className="tc__reply-ref"
          onClick={(e) => { e.stopPropagation(); onJumpToParent(comment.parentCommentId!); }}
          title={t("project.comments.jumpToParent")}
        >
          ↩ {parent ? preview(parent.body, 20) : t("project.comments.parentGone")}
        </button>
      )}
      {/* Clamped preview — full markdown lives in the detail modal on click. */}
      <div className="tc__card-body tc__card-body--clamp"><Markdown text={comment.body} /></div>
      {comment.attachments && comment.attachments.length > 0 && (
        <div className="tc__card-atts" onClick={(e) => e.stopPropagation()}>
          {comment.attachments.map((a) => (
            <AttachmentCard key={a.path ?? a.name} name={a.name} size={a.size} status="done" onOpen={() => onOpenAttachment(a)} />
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
function CommentDetailModal({ comment, parent, onClose, onReply, onOpenAttachment }: { comment: TaskComment; parent: TaskComment | undefined; onClose: () => void; onReply: () => void; onOpenAttachment: (att: CommentAttachment) => void }) {
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
          <span className="tcd__head-actions">
            <button className="td__icon-btn" onClick={onReply} title={t("project.comments.reply")} aria-label={t("project.comments.reply")}>↩</button>
            <button className="td__icon-btn" onClick={onClose} title={t("project.comments.detailClose")} aria-label={t("project.comments.detailClose")}>{Icon.x}</button>
          </span>
        </div>
        {comment.parentCommentId && (
          <div className="tcd__reply-ref">↩ {parent ? preview(parent.body, 40) : t("project.comments.parentGone")}</div>
        )}
        <div className="tcd__body"><Markdown text={comment.body} /></div>
        {comment.attachments && comment.attachments.length > 0 && (
          <div className="tcd__atts">
            {comment.attachments.map((a) => (
              <AttachmentCard key={a.path ?? a.name} name={a.name} size={a.size} status="done" onOpen={() => onOpenAttachment(a)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const PREVIEW_TEXT_EXT = new Set(["txt", "md", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "json", "yaml", "yml", "sh", "toml", "xml", "csv"]);
const PREVIEW_IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
function previewKindFor(name: string): "html" | "image" | "text" | "pdf" | "binary" {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  if (PREVIEW_IMG_EXT.has(ext)) return "image";
  if (PREVIEW_TEXT_EXT.has(ext)) return "text";
  return "binary";
}

/**
 * Preview/download one comment attachment. Fetches the file as an auth'd Blob
 * (the /api file endpoint needs a Bearer header a bare <iframe src> can't send),
 * wraps it in an object URL and renders inline by type — HTML in a sandboxed
 * iframe, images in <img>, text/markdown/code in <pre>, PDF in an iframe;
 * anything else is download-only. A download button is always present. Mirrors
 * the ArtifactBrowser viewer so the two stay visually consistent.
 */
function AttachmentPreview({
  api, taskId, commentId, att, onClose,
}: {
  api: ApiClient;
  taskId: string;
  commentId: string;
  att: CommentAttachment;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const kind = previewKindFor(att.name);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true); // capture: preempt parent Esc handlers
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const blob = await api.fetchCommentFile(taskId, commentId, att);
        if (cancelled) return;
        blobRef.current = blob;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
        if (kind === "text" || kind === "html") setText(await blob.text());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [api, taskId, commentId, att, kind]);

  const download = useCallback(() => {
    const blob = blobRef.current;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = att.name; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [att.name]);

  return (
    <div className="tcd-scrim" onClick={onClose}>
      <div className="tcd tcd--preview" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="tcd__head">
          <span className="tcd__who"><span className="tcd__who-label">{att.name}</span></span>
          <span className="tcd__head-actions">
            <button className="td__icon-btn" onClick={download} disabled={!blobUrl} title={t("project.artifacts.download")} aria-label={t("project.artifacts.download")}>⬇</button>
            <button className="td__icon-btn" onClick={onClose} title={t("project.comments.detailClose")} aria-label={t("project.comments.detailClose")}>{Icon.x}</button>
          </span>
        </div>
        <div className="tcd__preview-body">
          {error && <div className="artifacts__error">{error}</div>}
          {!error && !blobUrl && <div className="artifacts__hint artifacts__hint--center">{t("project.artifacts.loading")}</div>}
          {!error && blobUrl && kind === "html" && (
            <iframe className="artifacts__iframe" title={att.name} sandbox="allow-scripts allow-pointer-lock" srcDoc={text ?? ""} />
          )}
          {!error && blobUrl && kind === "image" && (
            <img className="artifacts__img" src={blobUrl} alt={att.name} />
          )}
          {!error && blobUrl && kind === "pdf" && (
            <iframe className="artifacts__iframe" title={att.name} src={blobUrl} />
          )}
          {!error && blobUrl && kind === "text" && (
            <pre className="artifacts__pre">{text}</pre>
          )}
          {!error && blobUrl && kind === "binary" && (
            <div className="artifacts__hint artifacts__hint--center">{t("project.artifacts.binaryHint")}</div>
          )}
        </div>
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
