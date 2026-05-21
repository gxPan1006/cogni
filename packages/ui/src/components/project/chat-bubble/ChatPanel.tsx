/**
 * ChatPanel — the popover chrome. A breadcrumb + (new / close) controls on top,
 * then either the SessionList (browse) or a SessionView (one conversation).
 * Purely presentational; all state lives in <ChatBubble>.
 */
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  return (
    <div className="cb-panel" role="dialog" aria-label={t("chat.bubble.dialogLabel")}>
      <div
        className="cb-resize"
        onMouseDown={onResizeStart}
        title={t("chat.bubble.resizeTitle")}
        aria-label={t("chat.bubble.resizeAria")}
      />

      <div className="cb-panel-top">
        <div className="cb-panel-crumb">
          {active ? t("chat.bubble.session") : t("chat.bubble.sessionCount", { count: sessions.length })}
        </div>
        <div className="cb-panel-top-right">
          <button className="cb-icon-btn" title={t("chat.bubble.newSession")} onClick={onNew} type="button">
            {Icon.plus}
          </button>
          <button className="cb-icon-btn" title={t("chat.bubble.collapseTitle")} onClick={onClose} type="button">
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
