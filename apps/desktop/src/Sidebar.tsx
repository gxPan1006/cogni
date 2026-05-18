/**
 * Sidebar — left rail with mode switcher / search / new / pinned / recents / host health / user menu.
 *
 * Same prop contract as the SP-1 spike, plus one new optional callback:
 *   - onOpenSettings — opens the Settings page in the main slot
 *
 * Visual rewrite:
 *   - Mode switcher is a single pill at the top (chat ↔ project)
 *   - Search field replaces the icon cluster
 *   - "Pinned" surfaces threads with `pinned: true` (SP-2 adds a pin column);
 *     for now everything goes under Recents
 *   - Host health summary above the user menu — counts online/total hosts
 *   - User menu doubles as the settings entry
 */
import type { ThreadSummary } from "@cogni/contract";
import { Icon } from "./icons.js";
import { LogoMark } from "./LogoMark.js";
import "./sidebar.css";

export function Sidebar(props: {
  mode: "chat" | "project";
  onMode: (m: "chat" | "project") => void;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onLogout: () => void;
  /** Optional: opens Settings in the main slot. */
  onOpenSettings?: () => void;
  /** Optional: host health summary. SP-1 doesn't fetch this yet, leave undefined. */
  hosts?: { online: number; total: number };
  /** Optional: signed-in user — SP-2 will fetch via /api/me. */
  user?: { name: string; email: string };
}) {
  const user = props.user ?? { name: "Cogni", email: "" };
  const initial = user.name.slice(0, 1).toUpperCase();

  return (
    <aside className="sb">
      <div className="sb__head">
        <Wordmark size={22} />
      </div>

      <div className="sb__modewrap">
        <div className="sb-mode">
          <button
            className={"sb-mode__btn" + (props.mode === "chat" ? " is-on" : "")}
            onClick={() => props.onMode("chat")}
          >
            {Icon.chat} Chat
          </button>
          <button
            className={"sb-mode__btn" + (props.mode === "project" ? " is-on" : "")}
            onClick={() => props.onMode("project")}
            title="项目 — SP-3 即将上线"
          >
            {Icon.kanban} 项目
          </button>
        </div>
      </div>

      <div className="sb__search">
        <span className="sb__search-icon">{Icon.search}</span>
        <input className="sb__search-input" placeholder={props.mode === "chat" ? "搜索对话" : "搜索项目"} />
        <span className="sb__search-kbd">⌘K</span>
      </div>

      <button className="sb__new" onClick={props.onNewChat}>
        {Icon.plus}
        <span>新 {props.mode === "chat" ? "对话" : "项目"}</span>
        <span className="sb__new-kbd">⌘N</span>
      </button>

      <div className="sb__body">
        <section className="sb__section">
          <div className="sb__section-head">PINNED</div>
          <div className="sb__section-body">
            {props.threads.filter((t) => (t as ThreadSummary & { pinned?: boolean }).pinned).length === 0 ? (
              <div className="sb__empty">Drag to pin</div>
            ) : (
              props.threads
                .filter((t) => (t as ThreadSummary & { pinned?: boolean }).pinned)
                .map((t) => (
                  <ThreadButton
                    key={t.id}
                    thread={t}
                    active={t.id === props.activeThreadId}
                    onClick={() => props.onSelect(t.id)}
                  />
                ))
            )}
          </div>
        </section>

        <section className="sb__section">
          <div className="sb__section-head">RECENTS</div>
          <div className="sb__section-body">
            {props.threads.map((t) => (
              <ThreadButton
                key={t.id}
                thread={t}
                active={t.id === props.activeThreadId}
                onClick={() => props.onSelect(t.id)}
              />
            ))}
          </div>
        </section>
      </div>

      {props.hosts && (
        <div className="sb__hosts">
          <span className="sb__hosts-label">HOSTS</span>
          <span className="sb__hosts-count">{props.hosts.online} / {props.hosts.total} online</span>
        </div>
      )}

      <button className="sb__user" onClick={() => props.onOpenSettings?.()}>
        <span className="sb__avatar">{initial}</span>
        <span className="sb__user-text">
          <span className="sb__user-name">{user.name}</span>
          {user.email && <span className="sb__user-email">{user.email}</span>}
        </span>
        <span className="sb__user-cog">{Icon.cog}</span>
      </button>
    </aside>
  );
}

function ThreadButton({
  thread,
  active,
  onClick,
}: {
  thread: ThreadSummary;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={"sb-thread" + (active ? " is-active" : "")}
      onClick={onClick}
      title={thread.title}
    >
      <span className="sb-thread__title">{thread.title}</span>
    </button>
  );
}

function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <div className="sb__wordmark" style={{ fontSize: size }}>
      <LogoMark className="sb__logo-mark" size={size} />
      <span className="sb__wordmark-text" style={{ fontSize: size * 0.78 }}>cogni</span>
    </div>
  );
}
