import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import { logger } from "@cogni/shared";
import type { AnyDb } from "./db/client.js";
import type { Auth, SessionClaims } from "./auth.js";
import type { HostRouter } from "./host-router.js";
import type { ClientHub } from "./client-hub.js";
import type { ChatDomain } from "./domains/chat.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHostWs } from "./routes/host-ws.js";
import { registerClientRoutes } from "./routes/client.js";

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
  publicUrl: string;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  const corsMiddleware = cors({
    origin: ["tauri://localhost", "http://localhost:1420"],
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  });
  app.use("/api/*", corsMiddleware);
  // /auth/dev-token is an XHR from the desktop dev fallback (see useAuth.ts);
  // the rest of /auth/* are browser-redirect endpoints and CORS is a no-op for
  // them. Cheap to enable across the whole prefix.
  app.use("/auth/*", corsMiddleware);

  app.get("/health", (c) => c.json({ ok: true }));

  app.onError((err, c) => {
    logger.error({ err: String(err), path: c.req.path }, "unhandled request error");
    return c.json({ error: "internal" }, 500);
  });

  registerAuthRoutes(app, deps);                   // Task 11
  registerHostWs(app, upgradeWebSocket, deps);     // Task 12
  registerClientRoutes(app, upgradeWebSocket, deps); // Task 13

  return { app, injectWebSocket };
}
