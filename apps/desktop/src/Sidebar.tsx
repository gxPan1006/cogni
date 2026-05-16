/**
 * Sidebar — left rail with tabs / nav / Recents / footer.
 *
 * Owned by Track A. Props and the root className are settled by Phase 1 — Track A
 * fills in the markup and `sidebar.css`. The root <aside> already has the right
 * width / background via .layout > .sidebar (see layout.css), so Track A's CSS
 * is purely about *inside* the sidebar.
 *
 * Visual target: ai-cognit webchat sidebar (see
 * /Users/guoxunpan/code/ai-cognit/backend/src/channels/webchat/static/index.html
 * lines 18-82 — tabs row, sbar-nav, sbar-scroll with Pinned/Recents, sbar-footer).
 * `mode` ("chat" | "project") replaces ai-cognit's "Projects" nav slot — the rest
 * of the visual layout is identical.
 */
import type { ThreadSummary } from "@cogni/contract";
import "./sidebar.css";

export function Sidebar(props: {
  mode: "chat" | "project";
  onMode: (m: "chat" | "project") => void;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** Track A: wire this to the footer avatar menu / logout item. */
  onLogout: () => void;
}) {
  // Stub markup — Track A replaces the whole tree below.
  return (
    <aside className="sidebar">
      <div className="sidebar__tabs">
        <button
          className={props.mode === "chat" ? "is-active" : ""}
          onClick={() => props.onMode("chat")}
        >
          Chat
        </button>
        <button disabled title="项目 ships in SP-3">项目</button>
      </div>

      <nav className="sidebar__nav">
        <button className="sidebar__new-chat" onClick={props.onNewChat}>
          + New chat
        </button>
      </nav>

      <div className="sidebar__scroll">
        <div className="sidebar__section">
          <div className="sidebar__section-title">Recents</div>
          <div className="sidebar__recents">
            {props.threads.map((t) => (
              <div
                key={t.id}
                className={
                  "sidebar__recent" +
                  (t.id === props.activeThreadId ? " is-active" : "")
                }
                onClick={() => props.onSelect(t.id)}
              >
                {t.title}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="sidebar__footer">
        <button className="sidebar__logout" onClick={props.onLogout}>
          退出登录
        </button>
      </div>
    </aside>
  );
}
