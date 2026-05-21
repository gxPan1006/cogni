/**
 * AttachmentCard — the single visual for an attached file, shared by the
 * Composer (interactive: progress + remove/retry) and the chat bubble
 * (read-only). A small typed tile (image thumbnail when we have the bytes,
 * otherwise an uppercase extension badge tinted by file kind) sits beside the
 * name + size. Cohesive with Cogni's warm-sand tokens; no flat gray pills.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import "./attachment.css";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp", "avif"]);
const CODE_EXT = new Set([
  "js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "hpp",
  "json", "jsonl", "sh", "rb", "php", "sql", "yml", "yaml", "toml", "css", "html",
]);
const DOC_EXT = new Set(["txt", "md", "doc", "docx", "rtf", "csv", "tsv"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "rar", "7z"]);

export type AttachmentKind = "img" | "pdf" | "code" | "doc" | "zip" | "file";

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
function kindOf(ext: string): AttachmentKind {
  if (IMAGE_EXT.has(ext)) return "img";
  if (ext === "pdf") return "pdf";
  if (CODE_EXT.has(ext)) return "code";
  if (DOC_EXT.has(ext)) return "doc";
  if (ARCHIVE_EXT.has(ext)) return "zip";
  return "file";
}
export function humanSize(n?: number): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentCard({
  name,
  size,
  previewUrl,
  progress,
  status = "done",
  error,
  onRemove,
  onRetry,
  onOpen,
}: {
  name: string;
  size?: number;
  /** Object URL for an inline image thumbnail (composer-side, when we hold the File). */
  previewUrl?: string;
  /** 0..1, rendered as a bottom progress bar while uploading. */
  progress?: number;
  status?: "uploading" | "done" | "error";
  error?: string;
  onRemove?: () => void;
  onRetry?: () => void;
  /** When set, the whole tile becomes a button that opens a preview/download. */
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const ext = extOf(name);
  const kind = kindOf(ext);
  const uploading = status === "uploading";
  const isError = status === "error";
  const badge = ext ? ext.toUpperCase().slice(0, 4) : "FILE";

  return (
    <div
      className={`att-card att-card--${kind}${isError ? " att-card--error" : ""}${onOpen ? " att-card--clickable" : ""}`}
      title={error ?? name}
      {...(onOpen
        ? {
            role: "button",
            tabIndex: 0,
            onClick: onOpen,
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
            },
          }
        : {})}
    >
      <div className="att-card__tile">
        {previewUrl && kind === "img" ? (
          <img className="att-card__thumb" src={previewUrl} alt="" />
        ) : (
          <span className="att-card__badge">{badge}</span>
        )}
      </div>

      <div className="att-card__meta">
        <span className="att-card__name">{name}</span>
        <span className="att-card__sub">
          {isError ? t("chat.attachment.uploadFailed") : uploading ? `${Math.round((progress ?? 0) * 100)}%` : humanSize(size)}
        </span>
      </div>

      {isError && onRetry && (
        <button type="button" className="att-card__btn att-card__retry" onClick={onRetry} title={t("chat.common.retry")} aria-label={t("chat.attachment.retryUpload")}>↻</button>
      )}
      {onRemove && (
        <button type="button" className="att-card__btn att-card__x" onClick={onRemove} title={t("chat.attachment.removeTitle")} aria-label={t("chat.attachment.removeAria")}>✕</button>
      )}

      {uploading && (
        <span className="att-card__bar" aria-hidden="true">
          <i style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
        </span>
      )}
    </div>
  );
}
