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
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ThreadSummary } from "@cogni/contract";
import { api, ApiError } from "./api.js";
import { Sidebar } from "./Sidebar.js";
import { Conversation } from "./Conversation.js";
import { Welcome } from "./Welcome.js";
import { Settings } from "./Settings.js";

type Page = "chat" | "settings";

export function Shell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [mode, setMode] = useState<"chat" | "project">("chat");
  const [page, setPage] = useState<Page>("chat");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);

  const handleApiError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onLogout();
    else console.error("cloud request failed", e);
  };

  const refreshThreads = () => api.listThreads(token).then(setThreads).catch(handleApiError);
  useEffect(() => { refreshThreads(); }, [token]);

  // First login → register a runner-host + spawn the bundled sidecar.
  // Same heuristic as before: register fresh if cloud has no host OR
  // local host.json belongs to a different user (dogfood scenario).
  useEffect(() => {
    (async () => {
      const hosts = await api.listHosts(token);
      const localHostId = await invoke<string | null>("read_host_id");
      const localHostBelongsToUser =
        localHostId !== null && hosts.some((h) => h.id === localHostId);
      if (hosts.length === 0 || !localHostBelongsToUser) {
        const reg = await api.createHost(token, "My Computer");
        await invoke("write_host_config", {
          hostId: reg.hostId,
          registrationToken: reg.registrationToken,
          cloudUrl: api.wsUrl,
        });
      }
      await invoke("ensure_daemon");
    })().catch(handleApiError);
  }, [token]);

  const newChat = async (): Promise<string | null> => {
    try {
      const t = await api.createThread(token);
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

  return (
    <div className="layout">
      <Sidebar
        mode={mode}
        onMode={setMode}
        threads={threads}
        activeThreadId={activeThreadId}
        onSelect={(id) => { setActiveThreadId(id); setPage("chat"); }}
        onNewChat={() => { void newChat(); }}
        onLogout={onLogout}
        onOpenSettings={() => setPage("settings")}
      />
      <div className="main">
        {page === "settings" ? (
          <Settings onClose={() => setPage("chat")} />
        ) : activeThreadId ? (
          <Conversation
            token={token}
            threadId={activeThreadId}
            initialDraft={pendingFirstMessage ?? undefined}
            onConsumeInitialDraft={() => setPendingFirstMessage(null)}
            onTitleMaybeChanged={refreshThreads}
          />
        ) : (
          <Welcome onStartChat={startFromWelcome} />
        )}
      </div>
    </div>
  );
}
