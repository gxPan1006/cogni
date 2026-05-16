/**
 * Sidebar — left rail with tabs / nav / Pinned / Recents / footer.
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
 *
 * SP-1 reality vs ai-cognit reference:
 *   • Agents / Code / Search / Sidebar-toggle / Projects / Artifacts / Customize /
 *     Updates → all visual placeholders, click logs a "coming soon" console line.
 *   • 项目 tab next to Chat tab is disabled (SP-3 ships projects).
 *   • Pinned section shows an empty state ("Drag to pin") — no drag wiring yet.
 *   • Footer user name is hardcoded "Cogni" — SP-2 fetches real name from /api/me.
 */
import type { ThreadSummary } from "@cogni/contract";
import "./sidebar.css";

/** Visual-only placeholders log to console; real wiring lands in SP-2/SP-3. */
function comingSoon(name: string) {
  console.log("[sidebar] coming soon: " + name);
}

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
  return (
    <aside className="sidebar">
      {/* ─── top: chat/project tab + icon-btn cluster ─── */}
      <div className="sidebar__tabs">
        <button
          className={
            "sidebar__tab" + (props.mode === "chat" ? " is-active" : "")
          }
          onClick={() => props.onMode("chat")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.4 8.4 0 0 1-1 4 8.5 8.5 0 0 1-7.6 4.5 8.4 8.4 0 0 1-4-1L3 20l1-5a8.4 8.4 0 0 1-1-4 8.5 8.5 0 0 1 4.5-7.6 8.4 8.4 0 0 1 4-1A8.5 8.5 0 0 1 21 11.5z" />
          </svg>
          Chat
        </button>
        <button
          className="sidebar__tab"
          disabled
          title="SP-3 ships projects"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-9l-2-2H4a1 1 0 0 0-1 1z" />
          </svg>
          项目
        </button>

        <button
          className="icon-btn sidebar__toggle"
          title="Toggle sidebar"
          onClick={() => comingSoon("toggle sidebar")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
        <button
          className="icon-btn"
          title="Search"
          onClick={() => comingSoon("search")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.5" y2="16.5" />
          </svg>
        </button>
      </div>

      {/* ─── main nav: New chat + Projects / Artifacts / Customize ─── */}
      <nav className="sidebar__nav">
        <button
          className="sidebar__nav-item sidebar__nav-item--new"
          onClick={props.onNewChat}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New chat
        </button>
        <button
          className="sidebar__nav-item"
          disabled
          title="SP-3 ships projects"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-9l-2-2H4a1 1 0 0 0-1 1z" />
          </svg>
          Projects
        </button>
        <button
          className="sidebar__nav-item"
          disabled
          title="Artifacts coming soon"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9" />
          </svg>
          Artifacts
        </button>
        <button
          className="sidebar__nav-item"
          disabled
          title="Customize coming soon"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          Customize
        </button>
      </nav>

      {/* ─── scroll: Pinned (empty) + Recents (live) ─── */}
      <div className="sidebar__scroll">
        <div className="sidebar__section">
          <div className="sidebar__section-title">Pinned</div>
          <div className="sidebar__empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5M9 3h6v4a2 2 0 0 0 1 1.7l2 1.3v3H6v-3l2-1.3A2 2 0 0 0 9 7z" />
            </svg>
            Drag to pin
          </div>
        </div>

        <div className="sidebar__section">
          <div className="sidebar__section-title">Recents</div>
          <div className="sidebar__recents">
            {props.threads.map((t) => (
              <button
                key={t.id}
                className={
                  "sidebar__recent" +
                  (t.id === props.activeThreadId ? " is-active" : "")
                }
                onClick={() => props.onSelect(t.id)}
                title={t.title}
              >
                <span className="sidebar__recent-title">{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ─── footer: avatar + name + updates + logout ─── */}
      <div className="sidebar__footer">
        <div className="sidebar__avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        </div>
        {/* SP-2 fetch real name from /api/me */}
        <div className="sidebar__user-name">Cogni</div>
        <button
          className="icon-btn"
          disabled
          title="Updates"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="5" y1="21" x2="19" y2="21" />
          </svg>
        </button>
        <button
          className="icon-btn"
          title="退出登录"
          onClick={props.onLogout}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
