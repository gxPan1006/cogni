/**
 * Shell — top-level authenticated layout.
 *
 * Owned by Phase 1 (this file). Phase 2 agents do NOT touch Shell — they
 * render *into* the sidebar / main slots via the Sidebar / Welcome / Conversation
 * components. If a Phase 2 agent thinks Shell needs to change, they must stop
 * and escalate.
 *
 * Responsibilities (none of which Phase 2 should rebuild):
 *   • register a runner-host on first login (write host.json + spawn daemon)
 *   • own list-of-threads + active-thread state
 *   • mount Sidebar in the sidebar slot, Welcome or Conversation in the main slot
 *   • route 401 errors back to Login
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ThreadSummary } from "@cogni/contract";
import { api, ApiError } from "./api.js";
import { Sidebar } from "./Sidebar.js";
import { Conversation } from "./Conversation.js";
import { Welcome } from "./Welcome.js";

export function Shell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [mode, setMode] = useState<"chat" | "project">("chat");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // 401 → token expired → drop back to Login. Other errors are logged so they
  // don't get swallowed (and `threads` keeps being an array).
  const handleApiError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onLogout();
    else console.error("cloud request failed", e);
  };

  const refreshThreads = () => api.listThreads(token).then(setThreads).catch(handleApiError);
  useEffect(() => { refreshThreads(); }, [token]);

  // First login on a fresh machine → register a runner-host, write
  // ~/.cogni/host.json, spawn the bundled sidecar. If local host.json was
  // deleted while the cloud still has rows, treat as fresh and re-register.
  useEffect(() => {
    (async () => {
      const hosts = await api.listHosts(token);
      const hasHostConfig = await invoke<boolean>("has_host_config");
      if (hosts.length === 0 || !hasHostConfig) {
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

  // Create a thread and (optionally) immediately enter it.
  const newChat = async (): Promise<string | null> => {
    try {
      const t = await api.createThread(token);
      await refreshThreads();
      setActiveThreadId(t.id);
      return t.id;
    } catch (e) {
      handleApiError(e);
      return null;
    }
  };

  // Welcome composer hands a first message → create a thread, then the
  // Conversation that mounts will pick up the streaming when it sees the id.
  // (Sending the message itself is Track B's job inside Conversation — for now
  // we just hand the draft over via initialDraft.)
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
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
        onSelect={setActiveThreadId}
        onNewChat={() => { void newChat(); }}
        onLogout={onLogout}
      />
      <div className="main">
        {activeThreadId ? (
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
