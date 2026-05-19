/**
 * Shell — top-level authenticated layout.
 *
 * Owns: the local runner-host registration on first login, the active thread,
 * the list of threads, and which page is visible in the main slot (chat /
 * welcome / settings). Mounts Sidebar in the rail and the page in the slot.
 *
 * Changes vs SP-1 spike:
 *   - new `page` state for opening Settings without unmounting the shell
 *   - Sidebar receives `onOpenSettings`
 *   - Composer / Welcome already use the new components — no API change
 *
 * Phase 2 agents do NOT touch this file — render INTO the sidebar/main slots
 * via Sidebar / Conversation / Welcome / Settings. Escalate if you think this
 * file needs to change.
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ThreadSummary } from "@cogni/contract";
import { api, ApiError, type HostInfo } from "./api.js";
import { Sidebar, Conversation, Welcome, SettingsPage } from "@cogni/ui";
import { MOCK_PROJECTS } from "./mock.js";
import { Project } from "./Project.js";
import { ProjectsList } from "./ProjectsList.js";
import { ProjectSettings } from "./ProjectSettings.js";
import { NewProject, type NewProjectDraft } from "./NewProject.js";
import { NewTask, type NewTaskDraft } from "./NewTask.js";

type Page = "chat" | "settings" | "projects" | "project" | "project-settings";

// SP-3 backend isn't done yet — sidebar / project pages read straight from
// the design mocks. Swap for `useProjects(api)` when /projects ships.
const projects = MOCK_PROJECTS;

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
  const [hosts, setHosts] = useState<HostInfo[]>([]);

  // SP-3 project state (mock-backed until /projects ships)
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const handleApiError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onLogout();
    else console.error("cloud request failed", e);
  };

  const refreshThreads = () => api.listThreads().then(setThreads).catch(handleApiError);
  const refreshHosts = () => api.listHosts().then(setHosts).catch(handleApiError);
  useEffect(() => { refreshThreads(); refreshHosts(); }, [token]);

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
    return { name: claims.email.split("@")[0], email: claims.email };
  }, [token]);

  const newChat = async (): Promise<string | null> => {
    try {
      const t = await api.createThread();
      await refreshThreads();
      setActiveThreadId(t.id);
      setPage("chat");
      return t.id;
    } catch (e) {
      handleApiError(e);
      return null;
    }
  };

  const startFromWelcome = async (firstMessage: string) => {
    setPendingFirstMessage(firstMessage);
    await newChat();
  };

  const openProject = (id: string) => { setActiveProjectId(id); setPage("project"); };

  return (
    <div className="layout">
      <Sidebar
        mode={mode}
        onMode={(m) => {
          setMode(m);
          if (m === "chat") {
            setPage(activeThreadId ? "chat" : "chat");
          } else {
            setPage(activeProjectId ? "project" : "projects");
          }
        }}
        threads={threads}
        activeThreadId={activeThreadId}
        onSelect={(id) => { setActiveThreadId(id); setMode("chat"); setPage("chat"); }}
        onNewChat={() => { void newChat(); }}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={openProject}
        onNewProject={() => setNewProjectOpen(true)}
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
            projects={projects}
            onOpen={openProject}
            onNew={() => setNewProjectOpen(true)}
          />
        )}
        {page === "project" && activeProjectId && (
          <Project
            projectId={activeProjectId}
            onBack={() => setPage("projects")}
            onNewTask={() => setNewTaskOpen(true)}
            onOpenSettings={() => setPage("project-settings")}
          />
        )}
        {page === "project-settings" && activeProjectId && (
          <ProjectSettings
            projectId={activeProjectId}
            onClose={() => setPage("project")}
          />
        )}
        {page === "chat" && (
          activeThreadId ? (
            <Conversation
              api={api}
              threadId={activeThreadId}
              initialDraft={pendingFirstMessage ?? undefined}
              onConsumeInitialDraft={() => setPendingFirstMessage(null)}
              onTitleMaybeChanged={refreshThreads}
              hostName={hostName}
            />
          ) : (
            <Welcome onStartChat={startFromWelcome} hostName={hostName} />
          )
        )}
      </div>

      {newProjectOpen && (
        <NewProject
          onClose={() => setNewProjectOpen(false)}
          onCreate={(draft: NewProjectDraft) => {
            // SP-3: POST /projects then navigate into the new project.
            console.log("[shell] create project draft", draft);
            setNewProjectOpen(false);
          }}
        />
      )}
      {newTaskOpen && activeProjectId && (
        <NewTask
          onClose={() => setNewTaskOpen(false)}
          onCreate={(draft: NewTaskDraft) => {
            // SP-3: POST /projects/:id/tasks
            console.log("[shell] create task draft", { projectId: activeProjectId, draft });
            setNewTaskOpen(false);
          }}
        />
      )}
    </div>
  );
}
