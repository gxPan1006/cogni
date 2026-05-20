import type {
  ThreadSummary, ThreadDetail, HostRegistration,
  Project, ProjectTask, TaskRun, MergePolicy,
  FsBrowseResponse, GitDiffSnapshotResponse,
} from "@cogni/contract";
import { createWsClient, type WsClient } from "./ws-client.js";
import { ClientCache } from "./cache.js";

// ─── SP-3 input shapes for create / patch routes ──────────────────────────
//
// These are the request bodies the cloud's `/api/projects` + `/api/tasks`
// routes accept. The cloud Track C will validate them with its own zod
// schemas; ApiClient just forwards camelCase JSON.

export interface CreateProjectInput {
  name: string;
  description?: string;
  repoPath: string;
  defaultHostId: string;
  mergePolicy?: MergePolicy;
  testCommand?: string;
  concurrencyLimit?: number;
  systemPrompt?: string;
  /** Auto-push main to origin after each accepted task merges. */
  pushToRemote?: boolean;
  /** Ask the host to `git init` if `repoPath` is not already a repo. */
  initRepo?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  mergePolicy?: MergePolicy;
  testCommand?: string | null;
  concurrencyLimit?: number;
  systemPrompt?: string | null;
  defaultHostId?: string;
  pushToRemote?: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: 0 | 1 | 2 | 3 | 4;
  labels?: string[];
  /** SP-3+1 per-task host override; omit to use the project's default host. */
  hostId?: string;
}

/** The full GET /tasks/:id payload — task + its run history. */
export interface TaskDetailResponse {
  task: ProjectTask;
  runs: TaskRun[];
}

/**
 * Thrown by `ApiClient.*` methods on a non-2xx cloud response. `status` lets
 * callers react — e.g. drop back to the login screen on 401 (revoked session).
 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiConfig {
  cloudUrl: string;
  /** Read fresh on every request so token rotations (re-login) are picked up automatically. */
  getToken: () => string | null;
}

export interface HostInfo {
  id: string;
  name: string;
  status: string;
  lastSeen?: string | null;
}

export interface DeviceRow {
  id: string;
  deviceName: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

export interface IdentityRow {
  userId: string;
  kind: string;
  sub: string;
}

/**
 * Platform-agnostic transport. Desktop and web each construct one in their
 * own bootstrap (`apps/desktop/src/api.ts`, `apps/web/src/api.ts`) with a
 * `getToken` that reads from localStorage.
 *
 * No token is threaded through call arguments — the client reads
 * `cfg.getToken()` lazily, so a fresh login (which writes a new token to
 * localStorage) is picked up by the next call without re-wiring.
 */
export class ApiClient {
  constructor(private readonly cfg: ApiConfig) {}

  /**
   * Stale-while-revalidate cache shared by all data hooks on this client.
   * Hooks seed their initial state from here (synchronous, flash-free) and
   * write back on every fetch / WS delta. See `transport/cache.ts`.
   */
  readonly cache = new ClientCache();
  /** Keys with a prefetch GET already in flight — dedupes hover spam. */
  private readonly inflight = new Set<string>();

  get cloudUrl(): string { return this.cfg.cloudUrl; }
  get wsUrl(): string { return this.cfg.cloudUrl.replace(/^http/, "ws"); }

  /** `?token=<jwt>` suffix for browser WebSocket URLs (which can't send custom headers). */
  wsTokenQuery(): string {
    const t = this.cfg.getToken();
    return t ? `?token=${encodeURIComponent(t)}` : "";
  }

  /**
   * Long-lived multiplexed WS connection shared by all hooks attached to this
   * client. Lazy: not opened until the first `subscribeThread()`. The hook
   * layer is responsible for adding subscriptions, not for managing the
   * underlying socket — switching threads must NOT close the connection.
   */
  private _wsClient: WsClient | null = null;
  get wsClient(): WsClient {
    if (!this._wsClient) {
      this._wsClient = createWsClient(() => `${this.wsUrl}/api/ws${this.wsTokenQuery()}`);
    }
    return this._wsClient;
  }

  private authHeaders(extra?: Record<string, string>): HeadersInit {
    const t = this.cfg.getToken();
    return {
      "Content-Type": "application/json",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...extra,
    };
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new ApiError(res.status, `${init.method ?? "GET"} ${url} → ${res.status}`);
    }
    return (await res.json()) as T;
  }

  // ─── Threads ──────────────────────────────────────────────────────────
  listThreads = (): Promise<ThreadSummary[]> =>
    this.request(`${this.cloudUrl}/api/threads`, { headers: this.authHeaders() });

  createThread = (): Promise<ThreadSummary> =>
    this.request(`${this.cloudUrl}/api/threads`, { method: "POST", headers: this.authHeaders() });

  getThread = (id: string): Promise<ThreadDetail> =>
    this.request(`${this.cloudUrl}/api/threads/${id}`, { headers: this.authHeaders() });

  /** Stable per-user workspace orchestrator thread (kind=workspace). */
  getWorkspaceThread = (): Promise<{ threadId: string }> =>
    this.request(`${this.cloudUrl}/api/workspace-thread`, { headers: this.authHeaders() });

  /** Project-scoped orchestrator thread (lazily created, kind=workspace). */
  getProjectChatThread = (projectId: string): Promise<{ threadId: string }> =>
    this.request(`${this.cloudUrl}/api/projects/${projectId}/chat-thread`, { headers: this.authHeaders() });

  /**
   * List orchestrator chat sessions for a scope (floating chat bubble).
   * No projectId → workspace-level sessions; with projectId → that project's.
   */
  listOrchestratorThreads = (projectId?: string): Promise<ThreadSummary[]> =>
    this.request(
      `${this.cloudUrl}/api/orchestrator-threads${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      { headers: this.authHeaders() },
    );

  /** Open a fresh orchestrator session in a scope. */
  createOrchestratorThread = (projectId?: string): Promise<ThreadSummary> =>
    this.request(`${this.cloudUrl}/api/orchestrator-threads`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(projectId ? { projectId } : {}),
    });

  renameThread = (id: string, title: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/threads/${id}`, {
      method: "PATCH", headers: this.authHeaders(), body: JSON.stringify({ title }),
    });

  deleteThread = (id: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/threads/${id}`, {
      method: "DELETE", headers: this.authHeaders(),
    });

  // ─── Hosts ────────────────────────────────────────────────────────────
  listHosts = (): Promise<HostInfo[]> =>
    this.request(`${this.cloudUrl}/api/hosts`, { headers: this.authHeaders() });

  createHost = (name: string): Promise<HostRegistration> =>
    this.request(`${this.cloudUrl}/api/hosts`, {
      method: "POST", headers: this.authHeaders(), body: JSON.stringify({ name }),
    });

  renameHost = (id: string, name: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/hosts/${id}`, {
      method: "PATCH", headers: this.authHeaders(), body: JSON.stringify({ name }),
    });

  removeHost = (id: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/hosts/${id}`, {
      method: "DELETE", headers: this.authHeaders(),
    });

  // ─── Devices (auth_sessions) ──────────────────────────────────────────
  listDevices = (): Promise<DeviceRow[]> =>
    this.request(`${this.cloudUrl}/api/devices`, { headers: this.authHeaders() });

  revokeDevice = (id: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/devices/${id}`, {
      method: "DELETE", headers: this.authHeaders(),
    });

  // ─── Identities ───────────────────────────────────────────────────────
  listIdentities = (): Promise<IdentityRow[]> =>
    this.request(`${this.cloudUrl}/api/identities`, { headers: this.authHeaders() });

  deleteIdentity = (kind: string, sub: string): Promise<{ ok: true }> =>
    this.request(
      `${this.cloudUrl}/api/identities/${kind}/${encodeURIComponent(sub)}`,
      { method: "DELETE", headers: this.authHeaders() },
    );

  // ─── Auth (magic-link) ────────────────────────────────────────────────
  /**
   * `origin` controls which URL the cloud puts in the email body —
   * `cogni://auth?magic=…` for desktop, `${webUrl}/auth/email/callback?token=…`
   * for web. UI feedback: Login flips to "已发送…" with 60s resend cooldown
   * regardless of whether the email is known (anti-enumeration).
   */
  sendMagicLink = (email: string, origin: "desktop" | "web"): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/auth/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, origin }),
    });

  /**
   * Exchange a magic token (delivered via cogni:// deep link on desktop or
   * via the SPA route handler on web) for a 30-day JWT.
   */
  redeemMagic = (magic: string): Promise<{ token: string }> =>
    this.request(`${this.cloudUrl}/auth/email/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magic }),
    });

  // ─── Auth (email + password) ──────────────────────────────────────────
  /**
   * Email + password login. Returns a 30-day JWT on success; throws ApiError
   * (401) on any failure — UI must show one generic "邮箱或密码不正确" message,
   * never reveal whether the email exists.
   */
  passwordLogin = (email: string, password: string): Promise<{ token: string }> =>
    this.request(`${this.cloudUrl}/auth/password/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

  /**
   * Start registration. The cloud sends a verification email (or, if the email
   * already has a password, a recovery email) and always returns {ok:true}
   * (anti-enumeration). The user finishes by clicking the emailed link.
   */
  passwordRegister = (email: string, password: string, origin: "desktop" | "web"): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/auth/password/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, origin }),
    });

  /** Exchange a verify token (from the registration email link) for a JWT. */
  passwordVerify = (token: string): Promise<{ token: string }> =>
    this.request(`${this.cloudUrl}/auth/password/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

  /** Request a password reset email. Always {ok:true} (anti-enumeration). */
  passwordResetRequest = (email: string, origin: "desktop" | "web"): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/auth/password/reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, origin }),
    });

  /** Set a new password using a reset token (from the reset email link). */
  passwordResetConfirm = (token: string, password: string): Promise<{ token: string }> =>
    this.request(`${this.cloudUrl}/auth/password/reset/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });

  // ─── SP-3 Projects ────────────────────────────────────────────────────
  //
  // Endpoints below mirror spec §六 ("Cloud HTTP Routes"). All return
  // camelCase JSON. WS pushes for the same resources (`project-event` /
  // `task-event`) flow through `wsClient.subscribeProjects` etc; HTTP
  // here is for first-mount fetch + mutations.

  listProjects = (): Promise<Project[]> =>
    this.request(`${this.cloudUrl}/api/projects`, { headers: this.authHeaders() });

  createProject = (input: CreateProjectInput): Promise<Project> =>
    this.request(`${this.cloudUrl}/api/projects`, {
      method: "POST", headers: this.authHeaders(), body: JSON.stringify(input),
    });

  getProject = (id: string): Promise<Project> =>
    this.request(`${this.cloudUrl}/api/projects/${id}`, { headers: this.authHeaders() });

  updateProject = (id: string, patch: UpdateProjectInput): Promise<Project> =>
    this.request(`${this.cloudUrl}/api/projects/${id}`, {
      method: "PATCH", headers: this.authHeaders(), body: JSON.stringify(patch),
    });

  archiveProject = (id: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/projects/${id}/archive`, {
      method: "POST", headers: this.authHeaders(),
    });

  // ─── SP-3 Project tasks ───────────────────────────────────────────────

  listProjectTasks = (projectId: string): Promise<ProjectTask[]> =>
    this.request(`${this.cloudUrl}/api/projects/${projectId}/tasks`, {
      headers: this.authHeaders(),
    });

  createProjectTask = (projectId: string, input: CreateTaskInput): Promise<ProjectTask> =>
    this.request(`${this.cloudUrl}/api/projects/${projectId}/tasks`, {
      method: "POST", headers: this.authHeaders(), body: JSON.stringify(input),
    });

  getTaskDetail = (taskId: string): Promise<TaskDetailResponse> =>
    this.request(`${this.cloudUrl}/api/tasks/${taskId}`, { headers: this.authHeaders() });

  /**
   * Post a user reply to a `needs-input` task. The cloud forwards it to the
   * task's `executionThreadId` and lifecycle-transitions the task back to
   * `running` once it lands.
   */
  replyToTask = (taskId: string, content: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/tasks/${taskId}/reply`, {
      method: "POST", headers: this.authHeaders(), body: JSON.stringify({ content }),
    });

  acceptTask = (taskId: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/tasks/${taskId}/accept`, {
      method: "POST", headers: this.authHeaders(),
    });

  rejectTask = (taskId: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/tasks/${taskId}/reject`, {
      method: "POST", headers: this.authHeaders(),
    });

  retryTask = (taskId: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/tasks/${taskId}/retry`, {
      method: "POST", headers: this.authHeaders(),
    });

  cancelTask = (taskId: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/tasks/${taskId}/cancel`, {
      method: "POST", headers: this.authHeaders(),
    });

  /** GET the worktree's diff against its base branch — drawer "Review" tab. */
  getTaskDiff = (taskId: string): Promise<GitDiffSnapshotResponse> =>
    this.request(`${this.cloudUrl}/api/tasks/${taskId}/diff`, {
      headers: this.authHeaders(),
    });

  // ─── SP-3 fs-browse (web NewProject Step 0) ───────────────────────────
  /**
   * Browse a directory on the given host. The cloud forwards as a `fs-browse`
   * RPC; only directory entries are returned (no file bodies). Path defaults
   * to the host's $HOME if omitted.
   */
  fsBrowse = (hostId: string, path?: string): Promise<FsBrowseResponse> =>
    this.request(`${this.cloudUrl}/api/hosts/${hostId}/fs-browse`, {
      method: "POST", headers: this.authHeaders(),
      body: JSON.stringify({ path }),
    });

  // ─── SP-4 Artifacts ───────────────────────────────────────────────────
  //
  // Files live on the host; thin clients fetch them through the cloud. The
  // file endpoints sit behind the /api Bearer middleware, so a bare
  // <iframe src> / <a download> can't authenticate — instead we fetch with the
  // Authorization header and hand back a Blob the caller wraps in a
  // `URL.createObjectURL` (works uniformly for preview iframes, <img>, <pre>,
  // and download links).

  /** Project file tree — one directory, confined to the project's repoPath. */
  browseProjectDir = (projectId: string, path?: string): Promise<FsBrowseResponse> =>
    this.request(
      `${this.cloudUrl}/api/projects/${projectId}/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`,
      { headers: this.authHeaders() },
    );

  /** Fetch a project file's bytes as a Blob (auth'd). `download` forces attachment. */
  fetchProjectFile = (projectId: string, path: string): Promise<Blob> =>
    this.fetchBlob(`${this.cloudUrl}/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`);

  /** Chat thread's deliverable files (paths the runner Wrote/Edited this thread). */
  listThreadFiles = (threadId: string): Promise<{ files: { path: string; name: string }[] }> =>
    this.request(`${this.cloudUrl}/api/threads/${threadId}/files`, { headers: this.authHeaders() });

  /** Fetch a chat thread file's bytes as a Blob (auth'd, allowlisted server-side). */
  fetchThreadFile = (threadId: string, path: string): Promise<Blob> =>
    this.fetchBlob(`${this.cloudUrl}/api/threads/${threadId}/file?path=${encodeURIComponent(path)}`);

  private async fetchBlob(url: string): Promise<Blob> {
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new ApiError(res.status, `GET ${url} → ${res.status}`);
    return res.blob();
  }

  // ─── Prefetch (hover → warm the SWR cache) ────────────────────────────
  //
  // Fire-and-forget: called from sidebar / card `onMouseEnter`. They warm the
  // same cache keys the hooks read on mount, so the click that follows renders
  // instantly with zero flash. Each is a no-op if the key is already cached or
  // a request for it is already in flight.

  private dedupe(key: string, run: () => Promise<unknown>): void {
    if (!key || this.cache.has(key) || this.inflight.has(key)) return;
    this.inflight.add(key);
    void run()
      .catch(() => {})
      .finally(() => this.inflight.delete(key));
  }

  /** Warm a thread's message history (matches useThreadStream's seed key). */
  prefetchThread = (id: string): void =>
    this.dedupe(`thread:${id}`, () =>
      this.getThread(id).then((d) => this.cache.set(`thread:${id}`, d.messages ?? [])),
    );

  /** Warm a project's row + task list (matches useProjectBoard's seed keys). */
  prefetchProject = (id: string): void =>
    this.dedupe(`project:${id}`, () =>
      Promise.all([this.getProject(id), this.listProjectTasks(id)]).then(([p, ts]) => {
        this.cache.set(`project:${id}`, p);
        this.cache.set(`project-tasks:${id}`, ts);
      }),
    );

  /** Warm a task's detail envelope (matches useTaskDetail's seed key). */
  prefetchTask = (id: string): void =>
    this.dedupe(`task:${id}`, () =>
      this.getTaskDetail(id).then((d) => this.cache.set(`task:${id}`, d)),
    );
}
