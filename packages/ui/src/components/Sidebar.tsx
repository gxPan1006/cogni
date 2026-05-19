/**
 * Sidebar — left rail, now mode-aware.
 *
 * Adds in SP-3:
 *   - When `mode === "project"`, the Pinned/Recents list shows projects instead
 *     of threads, the "New chat" button becomes "New project", search placeholder
 *     swaps to "搜索项目", and each project row shows a live runner count + a
 *     small amber badge when needs-input > 0 (the sidebar-level "叫人" cue).
 *   - Two new optional callbacks: `onSelectProject` / `onNewProject`. The Shell
 *     keeps them paired with `mode` so the same "primary" button maps to the
 *     right action.
 *
 * Everything else (host health, user menu, mode pill, settings entry) is
 * unchanged — same look as SP-2.
 */
import type { ThreadSummary } from "@cogni/contract";
import { Icon } from "./icons.js";
import "./sidebar.css";

/**
 * Sidebar's view of a project. SP-3 Track E feeds this from
 * `useProjects(api)` (composed with per-project task aggregates) inside
 * the host Shell/App; the four counters / health flag are computed at
 * the page layer so this component stays a pure presenter.
 */
export type SidebarProject = {
  id: string;
  name: string;
  liveRunners: number;
  queuedCount: number;
  needsInputCount: number;
  health: "ok" | "warn" | "error";
  pinned?: boolean;
  archived?: boolean;
};

export function Sidebar(props: {
  mode: "chat" | "project";
  onMode: (m: "chat" | "project") => void;

  // chat mode
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;

  // project mode (SP-3)
  projects?: SidebarProject[];
  activeProjectId?: string | null;
  onSelectProject?: (id: string) => void;
  onNewProject?: () => void;

  onLogout: () => void;
  onOpenSettings?: () => void;
  hosts?: { online: number; total: number };
  user?: { name: string; email: string };
}) {
  const user = props.user ?? { name: "Cogni", email: "" };
  const initial = user.name.slice(0, 1).toUpperCase();

  const isChat = props.mode === "chat";
  const newAction  = isChat ? props.onNewChat : (props.onNewProject ?? (() => {}));
  const newLabel   = isChat ? "新对话" : "新项目";
  const searchHint = isChat ? "搜索对话" : "搜索项目";

  return (
    <aside className="sb">
      <div className="sb__head">
        <Wordmark size={22} />
      </div>

      <div className="sb__modewrap">
        <div className="sb-mode">
          <button className={"sb-mode__btn" + (isChat ? " is-on" : "")} onClick={() => props.onMode("chat")}>
            {Icon.chat} Chat
          </button>
          <button className={"sb-mode__btn" + (!isChat ? " is-on" : "")} onClick={() => props.onMode("project")}>
            {Icon.kanban} 项目
          </button>
        </div>
      </div>

      <div className="sb__search">
        <span className="sb__search-icon">{Icon.search}</span>
        <input className="sb__search-input" placeholder={searchHint} />
        <span className="sb__search-kbd">⌘K</span>
      </div>

      <button className="sb__new" onClick={newAction}>
        {Icon.plus}
        <span>{newLabel}</span>
        <span className="sb__new-kbd">⌘N</span>
      </button>

      <div className="sb__body">
        {isChat ? <ChatLists {...props} /> : <ProjectLists {...props} />}
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

/* ─── Chat lists ───────────────────────────────────────── */

function ChatLists(props: {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
}) {
  const pinned = props.threads.filter((t) => (t as ThreadSummary & { pinned?: boolean }).pinned);
  const rest   = props.threads.filter((t) => !(t as ThreadSummary & { pinned?: boolean }).pinned);

  return (
    <>
      {pinned.length > 0 && (
        <section className="sb__section">
          <div className="sb__section-head">PINNED</div>
          <div className="sb__section-body">
            {pinned.map((t) => (
              <ThreadButton key={t.id} thread={t} active={t.id === props.activeThreadId} onClick={() => props.onSelect(t.id)} />
            ))}
          </div>
        </section>
      )}
      <section className="sb__section">
        <div className="sb__section-head">RECENTS</div>
        <div className="sb__section-body">
          {rest.length > 0
            ? rest.map((t) => (
                <ThreadButton key={t.id} thread={t} active={t.id === props.activeThreadId} onClick={() => props.onSelect(t.id)} />
              ))
            : <div className="sb__empty">还没有对话</div>}
        </div>
      </section>
    </>
  );
}

function ThreadButton({ thread, active, onClick }: { thread: ThreadSummary; active: boolean; onClick: () => void }) {
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

/* ─── Project lists (SP-3) ─────────────────────────────── */

function ProjectLists(props: {
  projects?: SidebarProject[];
  activeProjectId?: string | null;
  onSelectProject?: (id: string) => void;
}) {
  const list = props.projects ?? [];
  const pinned   = list.filter((p) => p.pinned && !p.archived);
  const active   = list.filter((p) => !p.pinned && !p.archived);
  const archived = list.filter((p) => p.archived);

  return (
    <>
      {pinned.length > 0 && (
        <section className="sb__section">
          <div className="sb__section-head">PINNED</div>
          <div className="sb__section-body">
            {pinned.map((p) => (
              <ProjectButton key={p.id} project={p} active={p.id === props.activeProjectId} onClick={() => props.onSelectProject?.(p.id)} />
            ))}
          </div>
        </section>
      )}

      <section className="sb__section">
        <div className="sb__section-head">RECENTS</div>
        <div className="sb__section-body">
          {active.length > 0
            ? active.map((p) => (
                <ProjectButton key={p.id} project={p} active={p.id === props.activeProjectId} onClick={() => props.onSelectProject?.(p.id)} />
              ))
            : <div className="sb__empty">还没有项目</div>}
        </div>
      </section>

      {archived.length > 0 && (
        <section className="sb__section">
          <div className="sb__section-head">已归档</div>
          <div className="sb__section-body">
            {archived.map((p) => (
              <ProjectButton key={p.id} project={p} active={p.id === props.activeProjectId} onClick={() => props.onSelectProject?.(p.id)} dim />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function ProjectButton({ project, active, onClick, dim }: { project: SidebarProject; active: boolean; onClick: () => void; dim?: boolean }) {
  const live = project.liveRunners;
  const queued = project.queuedCount;
  return (
    <button
      className={"sb-project" + (active ? " is-active" : "") + (dim ? " sb-project--dim" : "")}
      onClick={onClick}
      title={project.name}
    >
      <div className="sb-project__row">
        <span className={`sb-project__health sb-project__health--${project.health}`} />
        <span className="sb-project__name">{project.name}</span>
        {project.needsInputCount > 0 && (
          <span className="sb-project__needs" title={`${project.needsInputCount} 个等你`}>
            <span className="sb-project__needs-dot" />
            {project.needsInputCount}
          </span>
        )}
      </div>
      <div className="sb-project__meta">
        {live > 0
          ? <><span className="dot" style={{ background: "var(--accent)" }} /><span>{live} 在跑</span></>
          : queued > 0
            ? <><span className="dot" style={{ background: "var(--muted)" }} /><span>{queued} 排队</span></>
            : <span>空闲</span>}
      </div>
    </button>
  );
}

/* ─── Wordmark (unchanged from SP-2) ────────────────────── */

function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <div className="sb__wordmark" style={{ fontSize: size }}>
      <span className="sb__wordmark-c" style={{ width: size, height: size, fontSize: size * 0.56 }}>c</span>
      <span className="sb__wordmark-text" style={{ fontSize: size * 0.78 }}>cogni</span>
    </div>
  );
}
