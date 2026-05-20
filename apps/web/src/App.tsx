/**
 * App — web SPA top-level routes.
 *
 * Routes:
 *   /auth/google/callback     GoogleAuthCallback (parses #token=, redirects to /chat)
 *   /auth/email/callback      EmailAuthCallback  (redeems ?token=, redirects to /chat)
 *   /login                    LoginPage
 *   /chat                     WebShell(page=chat) — Welcome in main slot
 *   /chat/:threadId           WebShell(page=chat) — Conversation in main slot
 *   /projects                 WebShell(page=projects) — list view
 *   /projects/:id             WebShell(page=project) — board view
 *   /projects/:id/settings    WebShell(page=project-settings)
 *   /settings                 WebShell(page=settings)
 *   /  and  *                 redirect → /chat
 *
 * SP-3 web shell additions (Track E):
 *   - Sidebar mode toggle wires Chat ↔ project mode; the mode flips routing
 *     between /chat and /projects.
 *   - Project list / board / settings + the NewProject / NewTask modals come
 *     from `@cogni/ui` (the same components desktop renders).
 *   - NewProject on web exposes a remote folder browser button — it calls
 *     `api.fsBrowse(hostId, path)` so users can pick a repo path on a host
 *     they don't have local file-system access to.
 *   - Conversation (when a task drawer is open) reuses the SP-2 useThreadStream
 *     subscription via the embedded thread section.
 */
import { Routes, Route, Navigate, useParams, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ThreadSummary, ProjectTask } from "@cogni/contract";
import {
  Login, Sidebar, Conversation, Welcome, SettingsPage,
  ProjectsList, ProjectBoard, TaskDetail,
  NewProject, NewTask, ProjectSettings,
  useProjects, useProjectBoard, Icon,
  ChatBubble,
  type HostInfo, type ProjectListItem, type NewProjectDraft, type NewTaskDraft,
} from "@cogni/ui";
import { api, ApiError } from "./api.js";
import { useAuthWeb } from "./useAuth-web.js";
import { GoogleAuthCallback, EmailAuthCallback, PasswordVerifyCallback, PasswordResetCallback } from "./AuthCallback.js";

export default function App() {
  return (
    <Routes>
      <Route path="/auth/google/callback" element={<GoogleAuthCallback />} />
      <Route path="/auth/email/callback" element={<EmailAuthCallback />} />
      <Route path="/auth/password/callback" element={<PasswordVerifyCallback />} />
      <Route path="/auth/password/reset" element={<PasswordResetCallback />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/settings" element={<RequireAuth><WebShell page="settings" /></RequireAuth>} />
      <Route path="/chat/:threadId" element={<RequireAuth><WebShell page="chat" /></RequireAuth>} />
      <Route path="/chat" element={<RequireAuth><WebShell page="chat" /></RequireAuth>} />
      <Route path="/projects" element={<RequireAuth><WebShell page="projects" /></RequireAuth>} />
      <Route path="/projects/:projectId" element={<RequireAuth><WebShell page="project" /></RequireAuth>} />
      <Route path="/projects/:projectId/settings" element={<RequireAuth><WebShell page="project-settings" /></RequireAuth>} />
      <Route path="/" element={<Navigate to="/chat" replace />} />
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuthWeb();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function LoginPage() {
  const {
    token, loginWithGoogle, loginWithEmail,
    passwordLogin, passwordRegister, passwordResetRequest,
  } = useAuthWeb();
  if (token) return <Navigate to="/chat" replace />;
  return (
    <Login
      onLoginWithGoogle={loginWithGoogle}
      onLoginWithEmail={loginWithEmail}
      onPasswordLogin={passwordLogin}
      onPasswordRegister={passwordRegister}
      onPasswordResetRequest={passwordResetRequest}
    />
  );
}

// Decode JWT payload (no verification — we trust the token we just received
// from the cloud and only read `email`/`sub` for the sidebar.)
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

type Page = "chat" | "settings" | "projects" | "project" | "project-settings";

function WebShell({ page }: { page: Page }) {
  const { token, logout } = useAuthWeb();
  const nav = useNavigate();
  const params = useParams<{ threadId?: string; projectId?: string }>();

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<{ name: string; size: number }[] | null>(null);

  // Mobile drawer: the left rail is off-canvas on narrow viewports and the
  // ☰ button in the top bar slides it in. Any route change (picking a thread /
  // project, opening settings) auto-closes it so the destination is visible.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    setSidebarOpen(false);
  }, [params.threadId, params.projectId, page]);

  const mode: "chat" | "project" =
    page === "projects" || page === "project" || page === "project-settings"
      ? "project" : "chat";

  // SP-3 hooks — `useProjects` is always live (powers the sidebar even
  // while the user is in Chat mode, since the sidebar displays project
  // counts when toggled). `useProjectBoard` keys on the active projectId
  // from the URL.
  const projectsHook = useProjects(api);
  const board = useProjectBoard(api, params.projectId ?? "");

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const handleApiError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) logout();
    else console.error("cloud request failed", e);
  };

  const refreshThreads = () =>
    api.listThreads().then(setThreads).catch(handleApiError);
  const refreshHosts = () =>
    api.listHosts().then(setHosts).catch(handleApiError);

  useEffect(() => {
    refreshThreads();
    refreshHosts();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refire only on identity change
  }, [token]);

  // Sidebar list-channel live updates. Cloud pushes `thread-meta` whenever a
  // thread's title or lastMsgAt changes (today: auto-title after the first
  // assistant reply lands). `thread-created` / `thread-deleted` cover
  // cross-device sync — same user opens the web app in two windows and
  // creates a chat on one; the other window's sidebar reflects it without
  // refresh. We rely on the WS-level reconnect to resubscribe on its own.
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
        } else if (frame.t === "host-meta") {
          // Precise per-host update (carries hostId + status + name). Keeps the
          // sidebar host count + project board's host indicator live without a
          // refetch when the runner-host connects / disconnects / is renamed.
          setHosts((prev) => {
            const next: HostInfo = {
              id: frame.hostId,
              name: frame.name,
              status: frame.status,
              lastSeen: frame.lastSeen,
            };
            const idx = prev.findIndex((h) => h.id === frame.hostId);
            if (idx === -1) return [...prev, next];
            return prev.map((h) => (h.id === frame.hostId ? next : h));
          });
        } else if (frame.t === "host-status") {
          // Coarse user-wide "some host (went) online/offline" signal with no
          // hostId. Refetch the authoritative list so the count is correct
          // even on first connect before any host-meta arrives.
          refreshHosts();
        }
      },
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one subscription per session
  }, [token]);

  const hostStats = useMemo(
    () =>
      hosts.length > 0
        ? { online: hosts.filter((h) => h.status === "online").length, total: hosts.length }
        : undefined,
    [hosts],
  );
  const primaryHost = useMemo(
    () => hosts.find((h) => h.status === "online") ?? hosts[0],
    [hosts],
  );
  const hostName = primaryHost?.name;

  const user = useMemo(() => {
    const claims = decodeJwt(token ?? "");
    if (!claims?.email) return undefined;
    const name = claims.email.split("@")[0] ?? claims.email;
    return { name, email: claims.email };
  }, [token]);

  const newChat = async (): Promise<string | null> => {
    try {
      const t = await api.createThread();
      setThreads((prev) => [t, ...prev]);
      nav(`/chat/${t.id}`);
      return t.id;
    } catch (e) {
      handleApiError(e);
      return null;
    }
  };

  const startFromWelcome = async (
    firstMessage: string,
    opts?: { threadId?: string; attachments?: { name: string; size: number }[] },
  ) => {
    setPendingFirstMessage(firstMessage);
    setPendingAttachments(opts?.attachments && opts.attachments.length > 0 ? opts.attachments : null);
    if (opts?.threadId) {
      // Welcome already created this thread (to land attachments) — pick it up
      // into the sidebar and navigate there instead of creating a new one.
      refreshThreads();
      nav(`/chat/${opts.threadId}`);
    } else {
      await newChat();
    }
  };

  const renameThread = (id: string, title: string) => {
    // Optimistic: update the row immediately; the cloud's `thread-meta`
    // broadcast (which also reaches this window) confirms it.
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    api.renameThread(id, title).catch((e) => { handleApiError(e); refreshThreads(); });
  };

  const deleteThread = (id: string) => {
    setThreads((prev) => prev.filter((t) => t.id !== id));
    // Leaving the deleted thread's route avoids a 404 fetch in <Conversation>.
    if (params.threadId === id) nav("/chat");
    api.deleteThread(id).catch((e) => { handleApiError(e); refreshThreads(); });
  };

  // Items shape for ProjectsList + Sidebar. Same approach as desktop Shell —
  // only the active project gets per-task counter aggregation; others render
  // 0 until opened. See Shell.tsx for the rationale.
  const items = useMemo<ProjectListItem[]>(() => {
    return projectsHook.projects.map((p) => {
      const isCurrent = p.id === params.projectId;
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
        project: p, liveRunners, queuedCount, needsInputCount, health,
        updatedAtLabel: relativeTime(p.updatedAt),
      };
    });
  }, [projectsHook.projects, params.projectId, board.tasks]);

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
      nav(`/projects/${created.id}`);
    } catch (e) {
      handleApiError(e);
    }
  };

  const handleCreateTask = async (draft: NewTaskDraft) => {
    if (!params.projectId) return;
    try {
      await board.createTask({ title: draft.title, description: draft.description || undefined, hostId: draft.hostId });
      setNewTaskOpen(false);
    } catch (e) {
      handleApiError(e);
    }
  };

  const handleUpdateProject = async (patch: Parameters<typeof api.updateProject>[1]) => {
    if (!params.projectId) return;
    try { await api.updateProject(params.projectId, patch); }
    catch (e) { handleApiError(e); }
  };
  const handleArchiveProject = async () => {
    if (!params.projectId) return;
    try {
      await projectsHook.archiveProject(params.projectId);
      nav("/projects");
    } catch (e) { handleApiError(e); }
  };

  const currentTitle =
    page === "settings" ? "设置"
    : mode === "project" ? "项目"
    : params.threadId ? (threads.find((t) => t.id === params.threadId)?.title ?? "对话")
    : "对话";

  return (
    <div className="layout">
      <Sidebar
        open={sidebarOpen}
        onNavigate={() => setSidebarOpen(false)}
        mode={mode}
        onMode={(m) => nav(m === "chat" ? "/chat" : "/projects")}
        threads={threads}
        activeThreadId={params.threadId ?? null}
        onSelect={(id) => nav(`/chat/${id}`)}
        onNewChat={() => { void newChat(); }}
        onRenameThread={renameThread}
        onDeleteThread={deleteThread}
        onPrefetch={api.prefetchThread}
        projects={sidebarProjects}
        activeProjectId={params.projectId ?? null}
        onSelectProject={(id) => nav(`/projects/${id}`)}
        onNewProject={() => setNewProjectOpen(true)}
        onPrefetchProject={api.prefetchProject}
        onLogout={logout}
        onOpenSettings={() => nav("/settings")}
        hosts={hostStats}
        user={user}
      />
      {sidebarOpen && (
        <button
          className="layout__scrim"
          aria-label="关闭菜单"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div className="main">
        <header className="mobile-topbar">
          <button
            className="mobile-topbar__menu"
            aria-label="打开菜单"
            onClick={() => setSidebarOpen(true)}
          >
            {Icon.menu}
          </button>
          <span className="mobile-topbar__title">{currentTitle}</span>
        </header>
        {page === "settings" && (
          <SettingsPage api={api} user={user} onClose={() => nav("/chat")} />
        )}
        {page === "projects" && (
          <ProjectsList
            items={items}
            loading={projectsHook.loading}
            onOpen={(id) => nav(`/projects/${id}`)}
            onNew={() => setNewProjectOpen(true)}
            onPrefetch={api.prefetchProject}
          />
        )}
        {page === "project" && params.projectId && (
          <ProjectBoard
            project={board.project}
            tasks={board.tasks}
            loading={board.loading}
            hosts={hosts}
            onBack={() => nav("/projects")}
            onNewTask={() => setNewTaskOpen(true)}
            onOpenSettings={() => nav(`/projects/${params.projectId}/settings`)}
            onOpenTask={(id) => setActiveTaskId(id)}
            onPrefetchTask={api.prefetchTask}
          />
        )}
        {page === "project-settings" && params.projectId && (
          <ProjectSettings
            project={board.project}
            hosts={hosts}
            loading={board.loading}
            onClose={() => nav(`/projects/${params.projectId}`)}
            onUpdate={handleUpdateProject}
            onArchive={handleArchiveProject}
          />
        )}
        {page === "projects" && <ChatBubble api={api} scope={{ kind: "workspace" }} />}
        {page === "project" && board.project && (
          <ChatBubble
            api={api}
            scope={{ kind: "project", projectId: board.project.id, projectName: board.project.name }}
          />
        )}
        {page === "chat" && (
          params.threadId ? (
            <Conversation
              api={api}
              threadId={params.threadId}
              initialDraft={pendingFirstMessage ?? undefined}
              initialAttachments={pendingAttachments ?? undefined}
              onConsumeInitialDraft={() => { setPendingFirstMessage(null); setPendingAttachments(null); }}
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
          onBrowseHost={(hostId, path) => api.fsBrowse(hostId, path)}
        />
      )}
      {newTaskOpen && params.projectId && (
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
