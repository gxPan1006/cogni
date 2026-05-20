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
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import type { ThreadSummary } from "@cogni/contract";
import { Icon } from "./icons.js";
import { LogoMark } from "./LogoMark.js";
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
  /** Rename a conversation in place. When omitted, the pencil affordance is hidden. */
  onRenameThread?: (id: string, title: string) => void;
  /** Delete a conversation. When omitted, the trash affordance is hidden. */
  onDeleteThread?: (id: string) => void;
  /** Hover-prefetch a thread's history into the SWR cache (no-op flash on click). */
  onPrefetch?: (id: string) => void;

  // project mode (SP-3)
  projects?: SidebarProject[];
  activeProjectId?: string | null;
  onSelectProject?: (id: string) => void;
  onNewProject?: () => void;
  /** Hover-prefetch a project's board into the SWR cache. */
  onPrefetchProject?: (id: string) => void;

  onLogout: () => void;
  onOpenSettings?: () => void;
  hosts?: { online: number; total: number };
  user?: { name: string; email: string };

  /**
   * Mobile drawer state. On narrow viewports the rail is positioned off-canvas
   * and slides in when `open` is true; on desktop the flag is ignored (the rail
   * is a static column). Defaults to closed.
   */
  open?: boolean;
  /**
   * Called after the user picks something that takes them somewhere (open a
   * thread/project, start a new one, open settings). The host uses this to
   * dismiss the mobile drawer so the destination is visible. Switching mode or
   * renaming/deleting in place does NOT fire it — the user stays in the rail.
   */
  onNavigate?: () => void;
}) {
  const user = props.user ?? { name: "Cogni", email: "" };
  const initial = user.name.slice(0, 1).toUpperCase();

  const isChat = props.mode === "chat";
  // Wrap navigating actions so the mobile drawer closes on its way to the
  // destination. No-op on desktop (onNavigate just clears already-false state).
  const goThenClose = (fn: () => void) => () => { fn(); props.onNavigate?.(); };
  const newAction  = goThenClose(isChat ? props.onNewChat : (props.onNewProject ?? (() => {})));
  const newLabel   = isChat ? "新对话" : "新项目";
  const searchHint = isChat ? "搜索对话" : "搜索项目";
  const selectThread = (id: string) => { props.onSelect(id); props.onNavigate?.(); };
  const selectProject = (id: string) => { props.onSelectProject?.(id); props.onNavigate?.(); };

  return (
    <aside className={"sb" + (props.open ? " sb--open" : "")}>
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
        {isChat
          ? <ChatLists {...props} onSelect={selectThread} />
          : <ProjectLists {...props} onSelectProject={selectProject} onPrefetchProject={props.onPrefetchProject} />}
      </div>

      {props.hosts && (
        <div className="sb__hosts">
          <span className="sb__hosts-label">HOSTS</span>
          <span className="sb__hosts-count">{props.hosts.online} / {props.hosts.total} online</span>
        </div>
      )}

      <button className="sb__user" onClick={() => { props.onOpenSettings?.(); props.onNavigate?.(); }}>
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
  onRenameThread?: (id: string, title: string) => void;
  onDeleteThread?: (id: string) => void;
  onPrefetch?: (id: string) => void;
}) {
  // Only one row is in rename / delete-confirm mode (or has its ⋮ menu open) at
  // a time; keeping that state here (not per-row) means switching threads or
  // modes cleanly resets any open input/menu, and the modes are mutually
  // exclusive.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);

  const pinned = props.threads.filter((t) => (t as ThreadSummary & { pinned?: boolean }).pinned);
  const rest   = props.threads.filter((t) => !(t as ThreadSummary & { pinned?: boolean }).pinned);

  const row = (t: ThreadSummary) => (
    <ThreadRow
      key={t.id}
      thread={t}
      active={t.id === props.activeThreadId}
      editing={editingId === t.id}
      confirmingDelete={confirmingId === t.id}
      menuOpen={menuId === t.id}
      canRename={!!props.onRenameThread}
      canDelete={!!props.onDeleteThread}
      onClick={() => props.onSelect(t.id)}
      onPrefetch={props.onPrefetch ? () => props.onPrefetch?.(t.id) : undefined}
      onToggleMenu={() => setMenuId((cur) => (cur === t.id ? null : t.id))}
      onCloseMenu={() => setMenuId(null)}
      onStartRename={() => { setMenuId(null); setConfirmingId(null); setEditingId(t.id); }}
      onCommitRename={(title) => {
        props.onRenameThread?.(t.id, title);
        setEditingId(null);
      }}
      onCancelRename={() => setEditingId(null)}
      onStartDelete={() => { setMenuId(null); setEditingId(null); setConfirmingId(t.id); }}
      onConfirmDelete={() => {
        props.onDeleteThread?.(t.id);
        setConfirmingId(null);
      }}
      onCancelDelete={() => setConfirmingId(null)}
    />
  );

  return (
    <>
      {pinned.length > 0 && (
        <section className="sb__section">
          <div className="sb__section-head">PINNED</div>
          <div className="sb__section-body">{pinned.map(row)}</div>
        </section>
      )}
      <section className="sb__section">
        <div className="sb__section-head">RECENTS</div>
        <div className="sb__section-body">
          {rest.length > 0 ? rest.map(row) : <div className="sb__empty">还没有对话</div>}
        </div>
      </section>
    </>
  );
}

function ThreadRow({
  thread, active, editing, confirmingDelete, menuOpen, canRename, canDelete,
  onClick, onPrefetch, onToggleMenu, onCloseMenu,
  onStartRename, onCommitRename, onCancelRename,
  onStartDelete, onConfirmDelete, onCancelDelete,
}: {
  thread: ThreadSummary;
  active: boolean;
  editing: boolean;
  confirmingDelete: boolean;
  menuOpen: boolean;
  canRename: boolean;
  canDelete: boolean;
  onClick: () => void;
  onPrefetch?: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const [draft, setDraft] = useState(thread.title);
  const kebabRef = useRef<HTMLButtonElement>(null);

  if (editing) {
    const commit = () => {
      const next = draft.trim();
      if (next && next !== thread.title) onCommitRename(next);
      else onCancelRename();
    };
    return (
      <div className={"sb-thread is-editing" + (active ? " is-active" : "")}>
        <input
          className="sb-thread__rename"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") onCancelRename();
          }}
        />
        <span className="sb-thread__actions">
          <button className="sb-thread__act" title="保存" onClick={commit}>{Icon.check}</button>
          <button className="sb-thread__act" title="取消" onClick={onCancelRename}>{Icon.x}</button>
        </span>
      </div>
    );
  }

  // In-place delete confirmation — no native popup. The row turns red and the
  // title is replaced by "删除「…」?" with a confirm (red ✓) / cancel (×) pair.
  if (confirmingDelete) {
    return (
      <div
        className={"sb-thread sb-thread--confirm" + (active ? " is-active" : "")}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") onCancelDelete(); }}
      >
        <span className="sb-thread__confirm" title={thread.title}>删除「{thread.title}」?</span>
        <span className="sb-thread__actions">
          <button className="sb-thread__act sb-thread__act--danger" title="确认删除" onClick={onConfirmDelete}>{Icon.check}</button>
          <button className="sb-thread__act" title="取消" onClick={onCancelDelete}>{Icon.x}</button>
        </span>
      </div>
    );
  }

  return (
    <div className={"sb-thread" + (active ? " is-active" : "") + (menuOpen ? " is-menu-open" : "")}>
      <button className="sb-thread__title" onClick={onClick} onMouseEnter={onPrefetch} title={thread.title}>
        {thread.title}
      </button>
      {(canRename || canDelete) && (
        <span className="sb-thread__actions">
          <button
            ref={kebabRef}
            className={"sb-thread__act" + (menuOpen ? " is-on" : "")}
            title="更多"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => { e.stopPropagation(); onToggleMenu(); }}
          >{Icon.more}</button>
        </span>
      )}
      {menuOpen && (
        <ThreadMenu
          anchor={kebabRef.current}
          onClose={onCloseMenu}
          onRename={canRename ? () => { setDraft(thread.title); onStartRename(); } : undefined}
          onDelete={canDelete ? onStartDelete : undefined}
        />
      )}
    </div>
  );
}

/**
 * Floating action menu for a thread row (⋮ → 重命名 / 删除). Rendered with
 * `position: fixed` and positioned from the kebab's bounding rect so it escapes
 * the sidebar's `overflow-y: auto` clip without a portal. Closes on outside
 * click, Escape, or item selection.
 */
function ThreadMenu({
  anchor, onClose, onRename, onDelete,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const MENU_W = 184;
    // Right-align the menu to the kebab, opening downward; clamp into the viewport.
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    const top = Math.min(r.bottom + 6, window.innerHeight - 120);
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return; // let the kebab's own click toggle it
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return (
    <div
      ref={ref}
      className="sb-menu"
      role="menu"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
    >
      {onRename && (
        <button className="sb-menu__item" role="menuitem" onClick={() => { onClose(); onRename(); }}>
          {Icon.edit}<span>重命名</span>
        </button>
      )}
      {onRename && onDelete && <div className="sb-menu__sep" />}
      {onDelete && (
        <button className="sb-menu__item sb-menu__item--danger" role="menuitem" onClick={() => { onClose(); onDelete(); }}>
          {Icon.trash}<span>删除</span>
        </button>
      )}
    </div>
  );
}

/* ─── Project lists (SP-3) ─────────────────────────────── */

function ProjectLists(props: {
  projects?: SidebarProject[];
  activeProjectId?: string | null;
  onSelectProject?: (id: string) => void;
  onPrefetchProject?: (id: string) => void;
}) {
  const list = props.projects ?? [];
  const pinned   = list.filter((p) => p.pinned && !p.archived);
  const active   = list.filter((p) => !p.pinned && !p.archived);
  const archived = list.filter((p) => p.archived);
  const onPrefetch = (id: string) => props.onPrefetchProject?.(id);

  return (
    <>
      {pinned.length > 0 && (
        <section className="sb__section">
          <div className="sb__section-head">PINNED</div>
          <div className="sb__section-body">
            {pinned.map((p) => (
              <ProjectButton key={p.id} project={p} active={p.id === props.activeProjectId} onClick={() => props.onSelectProject?.(p.id)} onPrefetch={() => onPrefetch(p.id)} />
            ))}
          </div>
        </section>
      )}

      <section className="sb__section">
        <div className="sb__section-head">RECENTS</div>
        <div className="sb__section-body">
          {active.length > 0
            ? active.map((p) => (
                <ProjectButton key={p.id} project={p} active={p.id === props.activeProjectId} onClick={() => props.onSelectProject?.(p.id)} onPrefetch={() => onPrefetch(p.id)} />
              ))
            : <div className="sb__empty">还没有项目</div>}
        </div>
      </section>

      {archived.length > 0 && (
        <section className="sb__section">
          <div className="sb__section-head">已归档</div>
          <div className="sb__section-body">
            {archived.map((p) => (
              <ProjectButton key={p.id} project={p} active={p.id === props.activeProjectId} onClick={() => props.onSelectProject?.(p.id)} onPrefetch={() => onPrefetch(p.id)} dim />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function ProjectButton({ project, active, onClick, onPrefetch, dim }: { project: SidebarProject; active: boolean; onClick: () => void; onPrefetch?: () => void; dim?: boolean }) {
  const live = project.liveRunners;
  const queued = project.queuedCount;
  return (
    <button
      className={"sb-project" + (active ? " is-active" : "") + (dim ? " sb-project--dim" : "")}
      onClick={onClick}
      onMouseEnter={onPrefetch}
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

/* ─── Wordmark ──────────────────────────────────────────── */

function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <div className="sb__wordmark" style={{ fontSize: size }}>
      <LogoMark className="sb__wordmark-mark" size={size} />
      <span className="sb__wordmark-text" style={{ fontSize: size * 0.78 }}>cogni</span>
    </div>
  );
}
