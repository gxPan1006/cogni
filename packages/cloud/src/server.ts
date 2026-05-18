import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import { logger } from "@cogni/shared";
import type { AnyDb } from "./db/client.js";
import type { Auth, SessionClaims } from "./auth.js";
import type { HostRouter } from "./host-router.js";
import type { ClientHub } from "./client-hub.js";
import type { ChatDomain } from "./domains/chat.js";
import type { EmailTransport } from "./email/transport.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEmailRoutes } from "./routes/email.js";
import { registerHostWs } from "./routes/host-ws.js";
import { registerClientRoutes } from "./routes/client.js";
import { registerIdentitiesRoutes } from "./routes/identities.js";
import { registerDevicesRoutes } from "./routes/devices.js";
import { registerHostsRoutes } from "./routes/hosts.js";
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

  return { app, injectWebSocket };
}
