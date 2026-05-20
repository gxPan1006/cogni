/**
 * ChatPanel — the popover chrome. A breadcrumb + (new / close) controls on top,
 * then either the SessionList (browse) or a SessionView (one conversation).
 * Purely presentational; all state lives in <ChatBubble>.
 */
import type { ThreadSummary } from "@cogni/contract";
import type { ApiClient } from "../../../transport/api.js";
import type { WorkspaceTaskFocus } from "../WorkspaceChatBar.js";
import { Icon } from "../../icons.js";
import { SessionList } from "./SessionList.js";
import { SessionView } from "./SessionView.js";

export function ChatPanel({
  api,
  sessions,
  active,
  scopeLabel,
  composerPlaceholder,
  focusedTask = null,
  onClearFocus,
  loading,
  creating,
  error,
  draft,
  setDraft,
  onPick,
  onNew,
  onBack,
  onClose,
  onResizeStart,
  onTitled,
}: {
  api: ApiClient;
  sessions: ThreadSummary[];
  active: ThreadSummary | null;
  scopeLabel: string;
  composerPlaceholder: string;
  focusedTask?: WorkspaceTaskFocus | null;
  onClearFocus?: () => void;
  loading: boolean;
  creating: boolean;
  error: string | null;
  draft: string;
  setDraft: (v: string) => void;
  onPick: (id: string) => void;
  onNew: () => void;
  onBack: () => void;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
  onTitled: (id: string, title: string) => void;
}) {
  return (
    <div className="cb-panel" role="dialog" aria-label="Cogni 编排">
      <div
        className="cb-resize"
        onMouseDown={onResizeStart}
        title="拖动缩放"
        aria-label="拖动缩放窗口"
      />

      <div className="cb-panel-top">
        <div className="cb-panel-crumb">
          {active ? "编排会话" : `编排会话 · ${sessions.length}`}
        </div>
        <div className="cb-panel-top-right">
          <button className="cb-icon-btn" title="新建会话" onClick={onNew} type="button">
            {Icon.plus}
          </button>
          <button className="cb-icon-btn" title="收起" onClick={onClose} type="button">
            {Icon.x}
          </button>
        </div>
      </div>

      <div className="cb-panel-body">
        {active ? (
          <SessionView
            key={active.id}
            api={api}
            session={active}
            draft={draft}
            setDraft={setDraft}
            placeholder={composerPlaceholder}
            focusedTask={focusedTask}
            onClearFocus={onClearFocus}
            onBack={onBack}
            onTitled={onTitled}
          />
        ) : (
          <SessionList
            sessions={sessions}
            scopeLabel={scopeLabel}
            loading={loading}
            creating={creating}
            error={error}
            onPick={onPick}
            onNew={onNew}
          />
        )}
      </div>
    </div>
  );
}
