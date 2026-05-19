import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import { logger } from "@cogni/shared";
import type { AnyDb } from "./db/client.js";
import type { Auth, SessionClaims } from "./auth.js";
import type { HostRouter } from "./host-router.js";
import type { ClientHub } from "./client-hub.js";
import type { ChatDomain } from "./domains/chat.js";
import type { Project, ProjectTask, MergePolicy, Priority } from "@cogni/contract";
import type { EmailTransport } from "./email/transport.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEmailRoutes } from "./routes/email.js";
import { registerHostWs } from "./routes/host-ws.js";
import { registerClientRoutes } from "./routes/client.js";
import { registerIdentitiesRoutes } from "./routes/identities.js";
import { registerDevicesRoutes } from "./routes/devices.js";
import { registerHostsRoutes } from "./routes/hosts.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerHealthRoutes } from "./routes/health.js";

/**
 * SP-3 ProjectDomain surface consumed by routes/projects.ts. Track B's
 * concrete class (`domains/project/index.ts`) implements this structurally
 * — we declare the interface here so routes + tests can type against it
 * even while Track B's implementation lands in parallel. Method semantics
 * follow spec §四 (lifecycle) + §六 (HTTP routes):
 *   - createProject runs `git-init-if-missing` if `initGit` is true
 *   - replyToTask only valid in needs-input
 *   - accept/reject only valid in reviewing
 *   - retry only valid in failed/done
 *   - cancel valid in any non-terminal state
 *   - getTaskDiff proxies to host RPC `git-diff-snapshot`
 *   - fsBrowse proxies to host RPC `fs-browse`
 * The domain throws `Error & { code, currentState? }` for non-200 paths;
 * routes/projects.ts maps them via `domainErrorResponse`.
 */
export interface ProjectDomain {
  createProject(input: {
    tenantId: string;
    userId: string;
    name: string;
    description?: string;
    repoPath: string;
    defaultHostId: string;
    mergePolicy?: MergePolicy;
    testCommand?: string;
    concurrencyLimit?: number;
    systemPrompt?: string;
    initGit?: boolean;
  }): Promise<Project>;
  updateProject(
    projectId: string,
    patch: {
      name?: string;
      description?: string | null;
      defaultHostId?: string;
      mergePolicy?: MergePolicy;
      testCommand?: string | null;
      concurrencyLimit?: number;
      systemPrompt?: string | null;
    },
  ): Promise<Project>;
  archiveProject(projectId: string): Promise<void>;

  createTask(input: {
    projectId: string;
    title: string;
    description?: string;
    priority?: Priority;
    labels?: string[];
    adapter?: string;
  }): Promise<ProjectTask>;

  replyToTask(taskId: string, content: string): Promise<void>;
  acceptTask(taskId: string): Promise<void>;
  rejectTask(taskId: string): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;

  getTaskDiff(
    taskId: string,
  ): Promise<{
    diff: string;
    stats: { files: number; additions: number; deletions: number };
  }>;

  fsBrowse(
    hostId: string,
    path: string | undefined,
  ): Promise<{
    entries: Array<{ name: string; type: "file" | "dir"; size?: number }>;
    cwd: string;
  }>;

  /** Stop reconcile loops + drain in-flight RPCs on shutdown. */
  dispose(): Promise<void>;
}

declare module "hono" {
  interface ContextVariableMap {
    claims: SessionClaims;
  }
}

export interface ServerDeps {
  db: AnyDb;
  auth: Auth;
  hosts: HostRouter;
  clients: ClientHub;
  chat: ChatDomain;
  /**
   * SP-3 project domain. Optional so SP-1/SP-2 tests + the staged Track B/C
   * landing path keep compiling: routes that need it 503 when absent, and
   * tests that don't exercise project surface can omit it. main.ts wires
   * the real instance.
   */
  projectDomain?: ProjectDomain;
  emailTransport: EmailTransport;
  magicLinkTtlMinutes: number;
  publicUrl: string;
  /** SP-2: where the web SPA lives (https://chat.ai-cognit.com). Used to build
   * Google `redirect_uri` and magic-link URLs when the user came from web. */
  webUrl: string;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // SP-2: web SPA at chat.ai-cognit.com calls these endpoints from browser
  // JS. localhost:5173 covers `pnpm --filter web dev`. tauri://localhost +
  // localhost:1420 cover desktop (Tauri prod / vite dev). Settings page needs
  // PATCH (rename host) + DELETE (revoke device, soft-remove host, disconnect
  // identity), hence the wider methods list.
  const allowedOrigins = new Set([
    "tauri://localhost",
    "http://localhost:1420",
    "http://localhost:5173",
    deps.webUrl,
  ]);
  const corsMiddleware = cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  app.use("/api/*", corsMiddleware);
  // /auth/dev-token is an XHR from the desktop dev fallback (see useAuth.ts);
  // the rest of /auth/* are browser-redirect endpoints and CORS is a no-op for
  // them. Cheap to enable across the whole prefix.
  app.use("/auth/*", corsMiddleware);

  // SP-2 followup: `/healthz` (canonical) + `/health` (legacy alias for CF
  // probe) now exercise a real DB ping instead of returning a static ok.
  registerHealthRoutes(app, deps);

  app.onError((err, c) => {
    logger.error({ err: String(err), path: c.req.path }, "unhandled request error");
    return c.json({ error: "internal" }, 500);
  });

  registerAuthRoutes(app, deps);                   // Google OAuth + dev-token
  registerEmailRoutes(app, deps);                  // Magic-link send/callback
  registerHostWs(app, upgradeWebSocket, deps);
  registerClientRoutes(app, upgradeWebSocket, deps); // also mounts the /api/* Bearer middleware
  // SP-2 settings routes — must come AFTER registerClientRoutes so they share
  // its `/api/*` Bearer + auth_session revocation middleware.
  registerIdentitiesRoutes(app, deps);
  registerDevicesRoutes(app, deps);
  registerHostsRoutes(app, deps);
  // SP-3 project domain REST routes + fs-browse passthrough. Same /api/*
  // Bearer middleware applies (registered by registerClientRoutes above).
  registerProjectsRoutes(app, deps);

  return { app, injectWebSocket };
}
