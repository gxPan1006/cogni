import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { AnyDb } from "./db/client.js";
import type { Auth } from "./auth.js";
import type { HostRouter } from "./host-router.js";
import type { ClientHub } from "./client-hub.js";
import type { ChatDomain } from "./domains/chat.js";
import { registerAuthRoutes } from "./routes/auth.js";

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

  app.get("/health", (c) => c.json({ ok: true }));

  registerAuthRoutes(app, deps);               // Task 11
  // registerHostWs(app, upgradeWebSocket, deps);   // Task 12
  // registerClientRoutes(app, upgradeWebSocket, deps); // Task 13

  return { app, injectWebSocket };
}
