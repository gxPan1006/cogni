/**
 * SessionList — the bubble's list view. Shows a "start new conversation" button
 * plus every orchestrator session for the current scope, newest first. Clicking
 * a row opens that session; the + button (and ⌘N) opens a fresh one.
 *
 * Data is real `ThreadSummary[]` (no preview/host fields), so each row reads
 * title · relative-time, with a muted scope subtitle. Empty scopes show a hint.
 */
import type { ThreadSummary } from "@cogni/contract";
import { Icon } from "../../icons.js";

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(iso).toLocaleDateString();
}

export function SessionList({
  sessions,
  scopeLabel,
  loading,
  creating,
  error,
  onPick,
  onNew,
}: {
  sessions: ThreadSummary[];
  scopeLabel: string;
  loading: boolean;
  creating: boolean;
  error: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="cb-list">
      <button className="cb-newchat" onClick={onNew} disabled={creating} type="button">
        <span className="cb-newchat-glyph">{Icon.plus}</span>
        <span className="cb-newchat-label">{creating ? "新建中…" : "开始新的编排对话"}</span>
        <span className="cb-newchat-kbd">⌘N</span>
      </button>

      {error && <div className="cb-list-error">{error}</div>}

      <div className="cb-list-head">会话</div>
      {loading && sessions.length === 0 && <div className="cb-list-empty">加载中…</div>}
      {!loading && sessions.length === 0 && (
        <div className="cb-list-empty">还没有编排会话,开一条新的吧。</div>
      )}
      {sessions.map((t) => (
        <button key={t.id} className="cb-row" onClick={() => onPick(t.id)} type="button">
          <div className="cb-row-line">
            <div className="cb-row-title">{t.title}</div>
            <div className="cb-row-time">{fmtRelative(t.updatedAt)}</div>
          </div>
          <div className="cb-row-sub">{scopeLabel}</div>
        </button>
      ))}
    </div>
  );
}
