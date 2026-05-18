import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { clientToCloudSchema, type RunnerEvent } from "@cogni/contract";
import type { CloudToClient } from "@cogni/contract";
import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { logger } from "@cogni/shared";
import { listThreads, createThread, getThreadDetail, threadBelongsToUser } from "../db/threads.js";
import { listEventsSince } from "../db/sessions.js";
import { events as eventsTable } from "../db/schema.js";
import { createHost, getActiveHostsForUser } from "../db/hosts.js";
import { getAuthSession, touchAuthSession } from "../db/auth-sessions.js";
import type { ServerDeps } from "../server.js";

/**
 * SP-2 hard cap on a single subscribe-thread catchup. If the unread tail
 * exceeds this, the cloud sends `catchup-too-long` and lets the client
 * decide (e.g., HTTP-pull the latest messages, then resubscribe from latest).
 */
const MAX_CATCHUP = 10_000;

/**
 * Desktop/web client routes: HTTP for thread CRUD + host registration (all
 * Bearer-JWT-authed under /api/*), and a WebSocket (/api/ws?token=<jwt>) for
 * the live chat stream (subscribe-thread / send / fan-out events).
 */
export function registerClientRoutes(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  deps: ServerDeps,
): void {
  // --- HTTP: Bearer-auth middleware for /api/* ---
  // /api/ws is exempt: a browser WebSocket handshake cannot send an
  // Authorization header, so that endpoint carries the JWT in the ?token=
  // query param and authenticates inside its own upgradeWebSocket handler.
  //
  // SP-2: after verifying the JWT signature we also look up auth_sessions to
  // enforce server-side revocation (settings "Revoke device" sets revoked_at,
  // and the next request from that device gets 401). Successful auth bumps
  // last_seen_at so the settings page can render "X ago".
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/ws") return next();
    const auth = c.req.header("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const claims = token ? await deps.auth.verifyToken(token) : null;
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    const session = await getAuthSession(deps.db, claims.sessionId);
    if (!session || session.revokedAt !== null) return c.json({ error: "unauthorized" }, 401);
    c.set("claims", claims);
    // Fire-and-forget — the request shouldn't wait on the timestamp bump.
    void touchAuthSession(deps.db, claims.sessionId).catch(() => undefined);
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
    // SP-2: excludes soft-removed hosts (filter on hosts.removed_at IS NULL).
    const hosts = await getActiveHostsForUser(deps.db, userId);
    return c.json(hosts.map((h) => ({ id: h.id, name: h.name, status: h.status })));
  });

  // --- WS: /api/ws?token=<jwt> ---
  app.get(
    "/api/ws",
    upgradeWebSocket(async (c) => {
      const claims = await deps.auth.verifyToken(c.req.query("token") ?? "");
      // SP-2: enforce revocation at handshake. The check runs once here, not
      // per message, because WS connections are long-lived and the cost of
      // hitting the DB on every frame would be prohibitive.
      const session = claims ? await getAuthSession(deps.db, claims.sessionId) : null;
      const authed = !!(claims && session && session.revokedAt === null);
      const clientId = randomUUID();
      let processing: Promise<void> = Promise.resolve();
      return {
        onOpen(_e, ws) {
          if (!authed || !claims) {
            ws.close(4001, "unauthorized");
            return;
          }
          deps.clients.register({
            clientId,
            userId: claims.userId,
            send: (m: CloudToClient) => ws.send(JSON.stringify(m)),
          });
        },
        onMessage(evt, ws) {
          // The `ws` library does not await an async onMessage, so streamed
          // frames would interleave. Chain them per-connection so messages are
          // processed in arrival order.
          processing = processing
            .then(async () => {
              if (!authed || !claims) return;
              let raw: unknown;
              try {
                raw = JSON.parse(String(evt.data));
              } catch {
                return; // non-JSON frame — ignore
              }
              const parsed = clientToCloudSchema.safeParse(raw);
              if (!parsed.success) return;
              const msg = parsed.data;

              // SP-1 legacy variants (kept for desktop clients pre-upgrade)
              if (msg.t === "subscribe") {
                if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) return;
                deps.clients.subscribe(clientId, msg.threadId);
                const host = deps.hosts.getHostForUser(claims.userId);
                deps.clients.broadcast(msg.threadId, { t: "host-status", online: host !== null });
              } else if (msg.t === "send") {
                if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) return;
                await deps.chat.handleClientSend({
                  userId: claims.userId,
                  threadId: msg.threadId,
                  content: msg.text,
                  sourceClientId: clientId,
                });
              }

              // SP-2 sync variants
              else if (msg.t === "subscribe-list") {
                deps.clients.subscribeList(clientId);
              } else if (msg.t === "subscribe-thread") {
                if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) {
                  ws.close(4003, "forbidden");
                  return;
                }
                deps.clients.subscribe(clientId, msg.threadId);
                await streamCatchup(deps, clientId, msg.threadId, msg.lastSeq ?? 0);
              } else if (msg.t === "unsubscribe-thread") {
                deps.clients.unsubscribeThread(clientId, msg.threadId);
              } else if (msg.t === "resolve-fallback") {
                await deps.chat.handleResolveFallback({
                  userId: claims.userId,
                  pendingMessageId: msg.pendingMessageId,
                  action: msg.action,
                  targetHostId: msg.targetHostId ?? null,
                  sourceClientId: clientId,
                });
              }
            })
            .catch((err) => {
              logger.warn({ err: String(err), clientId }, "client-ws onMessage failed");
            });
        },
        onClose() {
          deps.clients.unregister(clientId);
        },
      };
    }),
  );
}

/**
 * Replay events for a thread above lastSeq, then send catchup-complete.
 * Bails with catchup-too-long if the unread tail is bigger than MAX_CATCHUP —
 * the client is expected to drop back to an HTTP `getThread` and resubscribe.
 */
async function streamCatchup(
  deps: ServerDeps, clientId: string, threadId: string, lastSeq: number,
): Promise<void> {
  // Cheap pre-check to avoid loading 50k rows just to bail.
  const top = await deps.db
    .select({ s: eventsTable.seq })
    .from(eventsTable)
    .where(eq(eventsTable.threadId, threadId))
    .orderBy(desc(eventsTable.seq))
    .limit(1);
  const latestSeq = top[0]?.s ?? 0;
  const missingCount = Math.max(0, latestSeq - lastSeq);
  if (missingCount > MAX_CATCHUP) {
    deps.clients.sendToConn(clientId, { t: "catchup-too-long", threadId, latestSeq });
    return;
  }
  if (missingCount === 0) {
    deps.clients.sendToConn(clientId, { t: "catchup-complete", threadId, latestSeq });
    return;
  }
  const rows = await listEventsSince(deps.db, threadId, lastSeq);
  for (const r of rows) {
    deps.clients.sendToConn(clientId, {
      t: "event", threadId, seq: r.seq, event: r.payload as RunnerEvent,
    });
  }
  deps.clients.sendToConn(clientId, { t: "catchup-complete", threadId, latestSeq });
}
