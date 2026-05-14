import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { clientToCloudSchema } from "@cogni/contract";
import type { CloudToClient } from "@cogni/contract";
import { randomUUID } from "node:crypto";
import { logger } from "@cogni/shared";
import { listThreads, createThread, getThreadDetail, threadBelongsToUser } from "../db/threads.js";
import { listEventsSince } from "../db/sessions.js";
import { createHost, getUserHosts } from "../db/hosts.js";
import type { ServerDeps } from "../server.js";

/**
 * Desktop/web client routes: HTTP for thread CRUD + host registration (all
 * Bearer-JWT-authed under /api/*), and a WebSocket (/api/ws?token=<jwt>) for
 * the live chat stream (subscribe to a thread, send a message).
 */
export function registerClientRoutes(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  deps: ServerDeps,
): void {
  // --- HTTP: Bearer-auth middleware for /api/* ---
  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const claims = token ? await deps.auth.verifyToken(token) : null;
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    c.set("claims", claims);
    await next();
  });

  app.get("/api/threads", async (c) => {
    const { userId } = c.get("claims");
    return c.json(await listThreads(deps.db, userId));
  });
  app.post("/api/threads", async (c) => {
    const { userId, tenantId } = c.get("claims");
    return c.json(await createThread(deps.db, { userId, tenantId }));
  });
  app.get("/api/threads/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);
    const detail = await getThreadDetail(deps.db, id);
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/threads/:id/events", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);
    const sinceRaw = Number(c.req.query("since") ?? 0);
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
    return c.json(await listEventsSince(deps.db, id, since));
  });
  app.post("/api/hosts", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const body = await c.req.json().catch(() => ({}));
    const name = typeof (body as { name?: unknown }).name === "string"
      ? (body as { name: string }).name
      : "My Computer";
    return c.json(await createHost(deps.db, { userId, tenantId, name }));
  });
  app.get("/api/hosts", async (c) => {
    const { userId } = c.get("claims");
    const hosts = await getUserHosts(deps.db, userId);
    return c.json(hosts.map((h) => ({ id: h.id, name: h.name, status: h.status })));
  });

  // --- WS: /api/ws?token=<jwt> ---
  app.get(
    "/api/ws",
    upgradeWebSocket(async (c) => {
      const claims = await deps.auth.verifyToken(c.req.query("token") ?? "");
      const clientId = randomUUID();
      return {
        onOpen(_e, ws) {
          if (!claims) {
            ws.close(4001, "unauthorized");
            return;
          }
          deps.clients.register({
            clientId,
            userId: claims.userId,
            send: (m: CloudToClient) => ws.send(JSON.stringify(m)),
          });
        },
        async onMessage(evt) {
          try {
            if (!claims) return;
            let raw: unknown;
            try {
              raw = JSON.parse(String(evt.data));
            } catch {
              return; // non-JSON frame — ignore
            }
            const parsed = clientToCloudSchema.safeParse(raw);
            if (!parsed.success) return;
            const msg = parsed.data;
            if (msg.t === "subscribe") {
              if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) return;
              deps.clients.subscribe(clientId, msg.threadId);
              const host = deps.hosts.getHostForUser(claims.userId);
              deps.clients.broadcast(msg.threadId, { t: "host-status", online: host !== null });
            } else if (msg.t === "send") {
              if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) return;
              await deps.chat.handleClientSend(claims.userId, msg.threadId, msg.text);
            }
          } catch (err) {
            logger.warn({ err: String(err), clientId }, "client-ws onMessage failed");
          }
        },
        onClose() {
          deps.clients.unregister(clientId);
        },
      };
    }),
  );
}
