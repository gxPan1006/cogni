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
  // ~/.cogni/host.json, spawn the bundled sidecar. We register fresh in any
  // of three cases:
  //   1. The cloud has no host for this user.
  //   2. There's no local host.json at all.
  //   3. The local host.json's hostId is NOT in this user's host list —
  //      i.e. it was written for a different account (common during dogfood:
  //      sign out of Google, sign in as dev user, host.json still points at
  //      the old Google-owned host → daemon registers under the wrong user
  //      → cloud broadcasts host-status to that user's clients (none) →
  //      this user's webview thinks host is offline forever).
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
