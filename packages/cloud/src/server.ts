import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import { logger } from "@cogni/shared";
import type { AnyDb } from "./db/client.js";
import type { Auth, SessionClaims } from "./auth.js";
import type { HostRouter } from "./host-router.js";
import type { ClientHub } from "./client-hub.js";
import type { ChatDomain } from "./domains/chat.js";
import type { WorkspaceChatDomain } from "./domains/workspace-chat.js";
// SP-3 project domain — single source of truth is the concrete class in
// domains/project/index.ts (Track B). routes/projects.ts (Track C) types its
// handlers against this same type, so they see the same method surface as
// the runtime object main.ts constructs.
import type { ProjectDomain } from "./domains/project/index.js";
import type { EmailTransport } from "./email/transport.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEmailRoutes } from "./routes/email.js";
import { registerPasswordRoutes } from "./routes/password.js";
import { registerHostWs } from "./routes/host-ws.js";
import { registerClientRoutes } from "./routes/client.js";
import { registerIdentitiesRoutes } from "./routes/identities.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerDevicesRoutes } from "./routes/devices.js";
import { registerHostsRoutes } from "./routes/hosts.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerHealthRoutes } from "./routes/health.js";

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
   * SP-4 workspace-chat orchestrator domain. Optional for the same
   * test-ergonomics reason as `projectDomain`: when absent, the client WS
   * `send` handler falls back to the ordinary chat path for every thread.
   * Production main.ts always passes the real instance.
   */
  workspaceChat?: WorkspaceChatDomain;
  /**
   * SP-3 project domain. Optional so SP-1/SP-2 server-construction fixtures
   * keep compiling without having to wire a full orchestrator stack; routes
   * that need it 503 when absent. Production main.ts always passes the real
   * instance, so the optional `?` is purely a test-ergonomics escape hatch.
   */
  projectDomain?: ProjectDomain;
  emailTransport: EmailTransport;
  magicLinkTtlMinutes: number;
  publicUrl: string;
  /** SP-2: where the web SPA lives (https://chat.ai-cognit.com). Used to build
   * Google `redirect_uri` and magic-link URLs when the user came from web. */
  webUrl: string;
  /** Web Push public VAPID key, served to clients so they can subscribe. Null
   *  when push isn't configured — the /api/push routes 503. */
  vapidPublicKey?: string | null;
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
    // X-Filename carries the (URL-encoded) upload filename on POST /uploads;
    // it's a custom header, so it MUST be allowlisted or the browser/webview
    // CORS preflight rejects the upload (curl bypasses CORS, masking this).
    allowHeaders: ["Authorization", "Content-Type", "X-Filename"],
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
  registerPasswordRoutes(app, deps);               // Email + password register/verify/login/reset
  registerHostWs(app, upgradeWebSocket, deps);
  registerClientRoutes(app, upgradeWebSocket, deps); // also mounts the /api/* Bearer middleware
  // SP-2 settings routes — must come AFTER registerClientRoutes so they share
  // its `/api/*` Bearer + auth_session revocation middleware.
  registerIdentitiesRoutes(app, deps);
  registerProfileRoutes(app, deps);          // GET/PATCH /api/me — same /api/* Bearer middleware
  registerDevicesRoutes(app, deps);
  registerHostsRoutes(app, deps);
  // SP-3 project domain REST routes + fs-browse passthrough. Same /api/*
  // Bearer middleware applies (registered by registerClientRoutes above).
  registerProjectsRoutes(app, deps);
  // Web Push subscribe/unsubscribe + public-key. Same /api/* Bearer middleware.
  registerPushRoutes(app, deps);

  return { app, injectWebSocket };
}
