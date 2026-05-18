/**
 * App — web SPA top-level routes.
 *
 * Routes:
 *   /auth/google/callback   GoogleAuthCallback  (parses #token=..., redirects to /chat)
 *   /auth/email/callback    EmailAuthCallback   (redeems ?token=... magic, redirects to /chat)
 *   /login                  LoginPage           (or → /chat if already authed)
 *   /chat                   WebShell  page=chat (Welcome in main slot)
 *   /chat/:threadId         WebShell  page=chat (Conversation in main slot)
 *   /settings               WebShell  page=settings  (SettingsPage stub — see TODO)
 *   /  and  *               redirect → /chat
 *
 * User experience:
 *   - Unauthed visit to / or any /chat* path → redirected to /login, sees the
 *     Login card with "用 Google 登录" + email field.
 *   - After Google round-trip / magic-link redeem → lands on /chat → Sidebar
 *     on the left, Welcome card in the main slot.
 *   - Click an existing thread in Sidebar → URL becomes /chat/:threadId,
 *     Conversation appears in the main slot. Browser back/forward works.
 *   - Click "新建对话" → server creates a thread, URL navigates to /chat/<id>.
 *   - Click avatar in Sidebar → /settings → SettingsPage stub for now.
 *
 * SettingsPage in @cogni/ui is being added in plan Task 29 (post-fanout
 * integration). Until then we render a stub with TODO marker so the route
 * is reachable but visibly unfinished.
 */
import { Routes, Route, Navigate, useParams, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ThreadSummary } from "@cogni/contract";
import { Login, Sidebar, Conversation, Welcome, type HostInfo } from "@cogni/ui";
import { api, ApiError } from "./api.js";
import { useAuthWeb } from "./useAuth-web.js";
import { GoogleAuthCallback, EmailAuthCallback } from "./AuthCallback.js";

export default function App() {
  return (
    <Routes>
      <Route path="/auth/google/callback" element={<GoogleAuthCallback />} />
      <Route path="/auth/email/callback" element={<EmailAuthCallback />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <WebShell page="settings" />
          </RequireAuth>
        }
      />
      <Route
        path="/chat/:threadId"
        element={
          <RequireAuth>
            <WebShell page="chat" />
          </RequireAuth>
        }
      />
      <Route
        path="/chat"
        element={
          <RequireAuth>
            <WebShell page="chat" />
          </RequireAuth>
        }
      />
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
  const { token, loginWithGoogle, loginWithEmail } = useAuthWeb();
  if (token) return <Navigate to="/chat" replace />;
  return (
    <Login onLoginWithGoogle={loginWithGoogle} onLoginWithEmail={loginWithEmail} />
  );
}

// Decode JWT payload (no verification — we trust the token we just received
// from the cloud and only read `email`/`sub` for the sidebar. Same approach
// as apps/desktop/src/Shell.tsx; both will switch to /api/me later.)
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

function WebShell({ page }: { page: "chat" | "settings" }) {
  const { token, logout } = useAuthWeb();
  const nav = useNavigate();
  const params = useParams<{ threadId?: string }>();

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [mode, setMode] = useState<"chat" | "project">("chat");
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);

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

  // Sidebar host badge: {online, total}. Web does NOT auto-register a host
  // (unlike desktop, which spawns a bundled sidecar on first login). Users
  // pair a runner from the Settings page (Track L / plan Task 29). Until
  // they do, the sidebar simply shows nothing in the host slot.
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
        activeThreadId={params.threadId ?? null}
        onSelect={(id) => nav(`/chat/${id}`)}
        onNewChat={() => {
          void newChat();
        }}
        onLogout={logout}
        onOpenSettings={() => nav("/settings")}
        hosts={hostStats}
        user={user}
      />
      <div className="main">
        {page === "settings" ? (
          // TODO(SP-2 T29 integration): replace stub with <SettingsPage api={api}
          // onClose={() => nav("/chat")} /> once @cogni/ui exports SettingsPage
          // (Track J ships hooks, Track L ships UI; integrator wires them into
          // packages/ui then swaps this div).
          <SettingsStub onClose={() => nav("/chat")} />
        ) : params.threadId ? (
          <Conversation
            api={api}
            threadId={params.threadId}
            initialDraft={pendingFirstMessage ?? undefined}
            onConsumeInitialDraft={() => setPendingFirstMessage(null)}
            onTitleMaybeChanged={refreshThreads}
            hostName={hostName}
          />
        ) : (
          <Welcome onStartChat={startFromWelcome} hostName={hostName} />
        )}
      </div>
    </div>
  );
}

/** Temporary placeholder for the not-yet-merged SettingsPage from @cogni/ui. */
function SettingsStub({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ padding: 32, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>设置</h1>
      <p style={{ color: "var(--text-muted, #888)" }}>
        Settings 页面即将到位（plan Task 29 — Track J + L 集成后从{" "}
        <code>@cogni/ui</code> 引入 <code>SettingsPage</code>）。
      </p>
      <button onClick={onClose} style={{ marginTop: 16 }}>
        返回对话
      </button>
    </div>
  );
}
