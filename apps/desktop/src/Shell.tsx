/**
 * Shell — top-level authenticated layout.
 *
 * Owns: the local runner-host registration on first login, the active thread,
 * the active project / task selection, and which page is visible in the
 * main slot. Mounts Sidebar in the rail and the page in the slot.
 *
 * SP-3 wiring (Track E):
 *   - `useProjects(api)` replaces `MOCK_PROJECTS`; the sidebar / projects
 *     list / breadcrumb all read from the live row stream. WS pushes
 *     (`project-event` kind=created/updated/archived) are reduced into
 *     local state by the hook.
 *   - `useProjectBoard(api, activeProjectId)` powers the board view. The
 *     onNewTask modal calls its `createTask` mutator; the kanban / swarm
 *     / timeline render the hook's `tasks` directly.
 *   - `useTaskDetail` is mounted inside <TaskDetail> when a task is open;
 *     Shell only passes `taskId` + the surrounding context (project, hosts).
 *
 * Visible behaviour:
 *   - Sidebar shows real projects, with live counters that update when the
 *     cloud pushes a task-event (running count goes up, needs-input badge
 *     lights up, archived rows dim into "已归档").
 *   - 新项目 / 新任务 buttons open their respective modals; submit calls the
 *     hook mutators which return the created row; Shell navigates into it.
 *   - Project settings 保存 fires `updateProject`; archive fires
 *     `archiveProject`. Cloud's WS push refreshes the form via
 *     `useProjectBoard.project` re-rendering.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ThreadSummary, ProjectTask } from "@cogni/contract";
import { api, ApiError, type HostInfo } from "./api.js";
import {
  Sidebar, Conversation, Welcome, SettingsPage,
  ProjectsList, ProjectBoard, TaskDetail,
  NewProject, NewTask, ProjectSettings,
  useProjects, useProjectBoard, useGlobalShortcuts, useAutoHideScrollbars,
  ChatBubble,
  Icon,
  type ProjectListItem, type NewProjectDraft, type NewTaskDraft,
} from "@cogni/ui";

type Page = "chat" | "settings" | "projects" | "project" | "project-settings";

// Decode JWT `payload` (no verification — we trust the token we just received
// from the cloud and only read `email` / `sub` to populate the sidebar.
// SP-2 will replace this with `/api/me`.
function decodeJwt(token: string): { email?: string; sub?: string } | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function Shell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [mode, setMode] = useState<"chat" | "project">("chat");
  const [page, setPage] = useState<Page>("chat");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<{ name: string; size: number }[] | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostInfo[]>([]);

  // Empty-draft garbage collection — see the web Shell for the full rationale.
  // A thread opened via "新对话" / ⌘N that never received a message is deleted
  // the moment the user moves off it, so the sidebar doesn't accumulate stray
  // "New chat" rows. `onActivity` from <Conversation> clears the ref once a
  // message is sent, making the thread permanent.
  const emptyThreadId = useRef<string | null>(null);
  const prevActiveThreadId = useRef<string | null>(activeThreadId);

  // SP-3 project state (real, driven by hooks)
  const projectsHook = useProjects(api);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // Last task card opened on this board → orchestrator bubble's focus chip.
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  useEffect(() => { setFocusedTaskId(null); }, [activeProjectId]);
  const board = useProjectBoard(api, activeProjectId ?? "");
  const focusedTask = useMemo(() => {
    const t = focusedTaskId ? board.tasks.find((x) => x.id === focusedTaskId) : undefined;
    return t ? { id: t.id, ref: t.ref, title: t.title } : null;
  }, [focusedTaskId, board.tasks]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleApiError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onLogout();
    else console.error("cloud request failed", e);
  };

  const refreshThreads = () => api.listThreads().then(setThreads).catch(handleApiError);
  const refreshHosts = () => api.listHosts().then(setHosts).catch(handleApiError);
  useEffect(() => { refreshThreads(); refreshHosts(); }, [token]);

  // Sidebar list-channel live updates. Mirrors apps/web/src/App.tsx — cloud
  // pushes `thread-meta` (auto-title), `thread-created` (multi-window sync),
  // `thread-deleted`. WS-level reconnect resubscribes for us.
  useEffect(() => {
    const unsub = api.wsClient.subscribeList({
      onFrame: (frame) => {
        if (frame.t === "thread-meta") {
          setThreads((prev) =>
            prev.map((t) =>
              t.id === frame.threadId
                ? { ...t, title: frame.title, updatedAt: frame.lastMsgAt }
                : t,
            ),
          );
        } else if (frame.t === "thread-created") {
          setThreads((prev) =>
            prev.some((t) => t.id === frame.thread.id) ? prev : [frame.thread, ...prev],
          );
        } else if (frame.t === "thread-deleted") {
          setThreads((prev) => prev.filter((t) => t.id !== frame.threadId));
        }
      },
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one subscription per session
  }, [token]);

  // First login → register a runner-host + spawn the bundled sidecar.
  // Same heuristic as before: register fresh if cloud has no host OR
  // local host.json belongs to a different user (dogfood scenario).
  useEffect(() => {
    (async () => {
      const initialHosts = await api.listHosts();
      setHosts(initialHosts);
      const localHostId = await invoke<string | null>("read_host_id");
      const localHostBelongsToUser =
        localHostId !== null && initialHosts.some((h) => h.id === localHostId);
      if (initialHosts.length === 0 || !localHostBelongsToUser) {
        const reg = await api.createHost("My Computer");
        await invoke("write_host_config", {
          hostId: reg.hostId,
          registrationToken: reg.registrationToken,
          cloudUrl: api.wsUrl,
        });
        setHosts(await api.listHosts());
      }
      await invoke("ensure_daemon");
    })().catch(handleApiError);
  }, [token]);

  // Sidebar wants {online, total}; Composer/Welcome want the primary host's
  // name. SP-1: "primary" = first online host, falling back to first known
  // host. SP-2 will let the user pin one as default.
  const hostStats = useMemo(
    () => (hosts.length > 0 ? { online: hosts.filter((h) => h.status === "online").length, total: hosts.length } : undefined),
    [hosts],
  );
  const primaryHost = useMemo(
    () => hosts.find((h) => h.status === "online") ?? hosts[0],
    [hosts],
  );
  const hostName = primaryHost?.name;

  // SP-2 will swap this for /api/me; for now decode the JWT we already have.
  const user = useMemo(() => {
    const claims = decodeJwt(token);
    if (!claims?.email) return undefined;
    return { name: claims.email.split("@")[0]!, email: claims.email };
  }, [token]);

  // Delete a still-empty draft thread (local list + cloud). No-op once the ref
  // has been cleared by `onActivity`.
  const discardEmptyThread = (id: string) => {
    emptyThreadId.current = null;
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (activeThreadId === id) setActiveThreadId(null);
    api.deleteThread(id).catch(() => refreshThreads());
  };

  // Switched to another thread → drop the previous untouched draft.
  useEffect(() => {
    const prev = prevActiveThreadId.current;
    prevActiveThreadId.current = activeThreadId;
    if (prev && prev !== activeThreadId && emptyThreadId.current === prev) {
      discardEmptyThread(prev);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on thread switch only
  }, [activeThreadId]);

  // Left chat entirely (settings / projects) with an untouched draft open → drop it.
  useEffect(() => {
    if (page !== "chat" && emptyThreadId.current) {
      discardEmptyThread(emptyThreadId.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on page change only
  }, [page]);

  const newChat = async (opts?: { track?: boolean }): Promise<string | null> => {
    try {
      // Opening a new chat retires any previous untouched draft.
      if (emptyThreadId.current) discardEmptyThread(emptyThreadId.current);
      const t = await api.createThread();
      setThreads((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
      if (opts?.track !== false) emptyThreadId.current = t.id;
      setActiveThreadId(t.id);
      setPage("chat");
      return t.id;
    } catch (e) {
      handleApiError(e);
      return null;
    }
  };

  const startFromWelcome = async (
    firstMessage: string,
    opts?: { threadId?: string; attachments?: { name: string; size: number }[]; model?: string },
  ) => {
    setPendingFirstMessage(firstMessage);
    setPendingAttachments(opts?.attachments && opts.attachments.length > 0 ? opts.attachments : null);
    setPendingModel(opts?.model ?? null);
    if (opts?.threadId) {
      // Welcome already created this thread (to land attachments) — switch to it
      // instead of creating a new one.
      await refreshThreads();
      setActiveThreadId(opts.threadId);
      setPage("chat");
    } else {
      // Welcome always sends a first message right away, so the new thread is
      // never an empty draft — don't track it for GC.
      await newChat({ track: false });
    }
  };

  const renameThread = (id: string, title: string) => {
    // Optimistic update; the cloud's `thread-meta` broadcast (which also lands
    // on this client) confirms it.
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    api.renameThread(id, title).catch((e) => { handleApiError(e); refreshThreads(); });
  };

  const deleteThread = (id: string) => {
    if (emptyThreadId.current === id) emptyThreadId.current = null;
    setThreads((prev) => prev.filter((t) => t.id !== id));
    // If the open conversation was deleted, fall back to the Welcome screen.
    if (activeThreadId === id) { setActiveThreadId(null); setPage("chat"); }
    api.deleteThread(id).catch((e) => { handleApiError(e); refreshThreads(); });
  };

  const openProject = (id: string) => { setActiveProjectId(id); setPage("project"); };

  // SP-3 cards / sidebar need {liveRunners, queuedCount, needsInputCount,
  // health} alongside each Project row. The SP-3 contract's `Project` row
  // doesn't carry these — they're aggregates over the user's tasks. Shell
  // doesn't subscribe to *every* project's tasks (that would be a fan-out
  // mess), so we render zeros for projects we haven't opened yet, and the
  // open project's counters come from `board.tasks`. WS pushes for any
  // project's tasks the Shell is *not* explicitly subscribed to don't
  // arrive — that's fine; the user will see fresh counters on open.
  const items = useMemo<ProjectListItem[]>(() => {
    return projectsHook.projects.map((p) => {
      const isCurrent = p.id === activeProjectId;
      const projectTasks: ProjectTask[] = isCurrent ? board.tasks : [];
      const liveRunners = projectTasks.filter((t) => t.state === "running").length;
      const queuedCount = projectTasks.filter((t) => t.state === "queued").length;
      const needsInputCount = projectTasks.filter((t) => t.state === "needs-input").length;
      const failed = projectTasks.some((t) => t.state === "failed");
      const health: ProjectListItem["health"] =
        failed ? "error" :
        needsInputCount > 0 ? "warn" :
        "ok";
      return {
        project: p,
        liveRunners,
        queuedCount,
        needsInputCount,
        health,
        updatedAtLabel: relativeTime(p.updatedAt),
      };
    });
  }, [projectsHook.projects, activeProjectId, board.tasks]);

  const sidebarProjects = items.map((it) => ({
    id: it.project.id,
    name: it.project.name,
    liveRunners: it.liveRunners,
    queuedCount: it.queuedCount,
    needsInputCount: it.needsInputCount,
    health: it.health,
    pinned: it.pinned,
    archived: it.project.archivedAt !== null,
  }));

  // Modal handlers
  const handleCreateProject = async (draft: NewProjectDraft) => {
    try {
      const created = await projectsHook.createProject({
        name: draft.name,
        description: draft.description || undefined,
        repoPath: draft.repoPath,
        defaultHostId: draft.defaultHostId,
        concurrencyLimit: draft.concurrencyLimit,
        systemPrompt: draft.systemPrompt || undefined,
        mergePolicy: draft.mergePolicy,
        initRepo: draft.initRepo,
      });
      setNewProjectOpen(false);
      openProject(created.id);
    } catch (e) {
      handleApiError(e);
    }
  };

  const handleCreateTask = async (draft: NewTaskDraft) => {
    if (!activeProjectId) return;
    try {
      await board.createTask({ title: draft.title, description: draft.description || undefined, hostId: draft.hostId });
      setNewTaskOpen(false);
    } catch (e) {
      handleApiError(e);
    }
  };

  const handleUpdateProject = async (patch: Parameters<typeof api.updateProject>[1]) => {
    if (!activeProjectId) return;
    try {
      await api.updateProject(activeProjectId, patch);
    } catch (e) {
      handleApiError(e);
    }
  };
  const handleArchiveProject = async () => {
    if (!activeProjectId) return;
    try {
      await projectsHook.archiveProject(activeProjectId);
      setActiveProjectId(null);
      setPage("projects");
    } catch (e) {
      handleApiError(e);
    }
  };

  const switchMode = (m: "chat" | "project") => {
    setMode(m);
    if (m === "chat") setPage("chat");
    else setPage(activeProjectId ? "project" : "projects");
  };

  useAutoHideScrollbars();

  useGlobalShortcuts({
    onNewChat: () => { void newChat(); },
    onToggleSidebar: () => setSidebarCollapsed((c) => !c),
    onToggleMode: () => switchMode(mode === "chat" ? "project" : "chat"),
    onOpenSettings: () => setPage("settings"),
  });

  return (
    <div className={"layout" + (sidebarCollapsed ? " is-sb-collapsed" : "")}>
      {sidebarCollapsed && (
        <button
          className="sb-expand"
          title="展开侧边栏 (⌘\)"
          aria-label="展开侧边栏"
          onClick={() => setSidebarCollapsed(false)}
        >
          {Icon.panel}
        </button>
      )}
      <Sidebar
        mode={mode}
        onMode={switchMode}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        threads={threads}
        activeThreadId={activeThreadId}
        onSelect={(id) => { setActiveThreadId(id); setMode("chat"); setPage("chat"); }}
        onNewChat={() => { void newChat(); }}
        onRenameThread={renameThread}
        onDeleteThread={deleteThread}
        onPrefetch={api.prefetchThread}
        projects={sidebarProjects}
        activeProjectId={activeProjectId}
        onSelectProject={openProject}
        onNewProject={() => { void refreshHosts(); setNewProjectOpen(true); }}
        onPrefetchProject={api.prefetchProject}
        onLogout={onLogout}
        onOpenSettings={() => setPage("settings")}
        hosts={hostStats}
        user={user}
      />
      <div className="main">
        {page === "settings" && (
          <SettingsPage api={api} user={user} onClose={() => setPage("chat")} />
        )}
        {page === "projects" && (
          <ProjectsList
            items={items}
            loading={projectsHook.loading}
            onOpen={openProject}
            onNew={() => { void refreshHosts(); setNewProjectOpen(true); }}
            onPrefetch={api.prefetchProject}
          />
        )}
        {page === "project" && activeProjectId && (
          <ProjectBoard
            project={board.project}
            tasks={board.tasks}
            loading={board.loading}
            hosts={hosts}
            onBack={() => setPage("projects")}
            onNewTask={() => setNewTaskOpen(true)}
            onOpenSettings={() => setPage("project-settings")}
            onOpenTask={(id) => { setActiveTaskId(id); setFocusedTaskId(id); }}
            onPrefetchTask={api.prefetchTask}
            onMoveTask={(taskId, to) => void api.moveTaskState(taskId, to)}
          />
        )}
        {page === "project-settings" && activeProjectId && (
          <ProjectSettings
            project={board.project}
            hosts={hosts}
            loading={board.loading}
            onClose={() => setPage("project")}
            onUpdate={handleUpdateProject}
            onArchive={handleArchiveProject}
          />
        )}
        {page === "projects" && <ChatBubble api={api} scope={{ kind: "workspace" }} />}
        {page === "project" && board.project && (
          <ChatBubble
            api={api}
            scope={{ kind: "project", projectId: board.project.id, projectName: board.project.name }}
            focusedTask={focusedTask}
            onClearFocus={() => setFocusedTaskId(null)}
          />
        )}
        {page === "chat" && (
          activeThreadId ? (
            <Conversation
              api={api}
              threadId={activeThreadId}
              initialDraft={pendingFirstMessage ?? undefined}
              initialAttachments={pendingAttachments ?? undefined}
              initialModel={pendingModel ?? undefined}
              onConsumeInitialDraft={() => { setPendingFirstMessage(null); setPendingAttachments(null); setPendingModel(null); }}
              onActivity={() => { if (emptyThreadId.current === activeThreadId) emptyThreadId.current = null; }}
              onTitleMaybeChanged={refreshThreads}
              hostName={hostName}
            />
          ) : (
            <Welcome api={api} onStartChat={startFromWelcome} hostName={hostName} />
          )
        )}
      </div>

      {newProjectOpen && (
        <NewProject
          hosts={hosts}
          onClose={() => setNewProjectOpen(false)}
          onCreate={handleCreateProject}
          // Desktop has a native folder picker (tauri dialog); no fs-browse RPC here.
        />
      )}
      {newTaskOpen && activeProjectId && (
        <NewTask
          onClose={() => setNewTaskOpen(false)}
          onCreate={handleCreateTask}
          hosts={hosts}
          defaultHostId={board.project?.defaultHostId}
        />
      )}
      {activeTaskId && (
        <TaskDetail
          api={api}
          taskId={activeTaskId}
          project={board.project}
          hosts={hosts}
          allTaskIds={board.tasks.map((t) => t.id)}
          onClose={() => setActiveTaskId(null)}
          onNavigate={(id) => setActiveTaskId(id)}
        />
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
