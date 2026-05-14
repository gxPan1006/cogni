import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ThreadSummary } from "@cogni/contract";
import { api, ApiError } from "./api.js";
import { Sidebar } from "./Sidebar.js";
import { Conversation } from "./Conversation.js"; // created in Task 22

export function Shell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [mode, setMode] = useState<"chat" | "project">("chat");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // A 401 means the token expired — drop the user back to Login. Other errors
  // are logged so they're never silently swallowed (and `threads` stays an array).
  const handleApiError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onLogout();
    else console.error("cloud request failed", e);
  };

  const refreshThreads = () => api.listThreads(token).then(setThreads).catch(handleApiError);
  useEffect(() => {
    refreshThreads();
  }, [token]);

  // On login, make sure the user has a runner-host registered with the cloud and
  // that its local daemon is running. First login on a fresh machine registers a
  // host, writes ~/.cogni/host.json, then spawns the bundled runner-host sidecar;
  // later launches see a live pid and don't double-spawn. Once the daemon
  // connects, the conversation view's "本地运行环境未连接" banner clears.
  useEffect(() => {
    (async () => {
      const hosts = await api.listHosts(token);
      if (hosts.length === 0) {
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

  const newChat = async () => {
    try {
      const t = await api.createThread(token);
      await refreshThreads();
      setActiveThreadId(t.id);
    } catch (e) {
      handleApiError(e);
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar
        mode={mode}
        onMode={setMode}
        threads={threads}
        activeThreadId={activeThreadId}
        onSelect={setActiveThreadId}
        onNewChat={newChat}
      />
      <div style={{ flex: 1 }}>
        {activeThreadId ? (
          <Conversation token={token} threadId={activeThreadId} onTitleMaybeChanged={refreshThreads} />
        ) : (
          <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
            <button onClick={newChat}>开始一个新对话</button>
          </div>
        )}
      </div>
    </div>
  );
}
