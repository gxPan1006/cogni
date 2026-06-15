import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { clientToCloudSchema, type RunnerEvent } from "@cogni/contract";
import type { CloudToClient } from "@cogni/contract";
import { randomUUID } from "node:crypto";
import { logger } from "@cogni/shared";
import { z } from "zod";
import {
  listThreads, createThread, getThreadDetail, threadBelongsToUser,
  updateThreadTitle, softDeleteThread, getThreadKind,
} from "../db/threads.js";
import { listEventsSince, getLatestSessionForThread } from "../db/sessions.js";
import { getAuthSession, touchAuthSession } from "../db/auth-sessions.js";
import { findHostByToken } from "../db/hosts.js";
import { getProject, getTask } from "../db/projects.js";
import { artifactFileResponse } from "./artifact-file.js";
import { relayUpload } from "./upload.js";
import { sendHostRpc } from "./host-ws.js";
import type { ServerDeps } from "../server.js";

/** File-writing tool names across adapters (claude-code Write/Edit, etc.). */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "create_file", "apply_patch"]);

/**
 * The deliverable set for a chat thread = absolute paths the runner Wrote /
 * Edited, recovered from the tool-call event log (most-recent write of each
 * path wins; order preserved by last-seen). No git boundary exists for chat,
 * so this event-derived allowlist is what we expose + confine downloads to.
 */
async function threadWrittenFiles(deps: ServerDeps, threadId: string): Promise<string[]> {
  const evs = await listEventsSince(deps.db, threadId, 0);
  const seen: string[] = [];
  for (const e of evs) {
    if (e.type !== "tool-call") continue;
    const p = e.payload as { name?: unknown; input?: unknown };
    if (typeof p.name !== "string" || !WRITE_TOOLS.has(p.name)) continue;
    const input = p.input as { file_path?: unknown; path?: unknown } | null;
    const fp = input && typeof input === "object"
      ? (typeof input.file_path === "string" ? input.file_path
        : typeof input.path === "string" ? input.path : null)
      : null;
    if (fp && !seen.includes(fp)) seen.push(fp);
  }
  return seen;
}

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
    // SP-4 Host-token path: a registered runner host acts as its owning user.
    // The cogni MCP server (running on the host) sends its registrationToken so
    // orchestrator tool-calls can hit the same REST surface as the desktop app.
    if (auth?.startsWith("Host ")) {
      const host = await findHostByToken(deps.db, auth.slice(5));
      if (!host) return c.json({ error: "unauthorized" }, 401);
      c.set("claims", {
        userId: host.userId,
        tenantId: host.tenantId,
        sessionId: `host:${host.id}`,
      });
      return next();
    }
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

  // Shared validator for PATCH /api/threads/:id (sidebar rename).
  const renameSchema = z.object({ title: z.string().min(1).max(200) });

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
  // Rename a conversation (sidebar inline edit). Mirrors PATCH /api/hosts/:id:
  // ownership-checked (404, never 403, to avoid leaking thread-id existence),
  // then fans out the new title over the list channel so every other window
  // updates live. Reuses the same `thread-meta` frame the auto-titler emits.
  app.patch("/api/threads/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = renameSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid title" }, 400);

    const updated = await updateThreadTitle(deps.db, id, parsed.data.title.trim());
    if (!updated) return c.json({ error: "not found" }, 404);
    deps.clients.publishThreadMeta(userId, {
      threadId: id,
      title: updated.title,
      lastMsgAt: updated.updatedAt,
    });
    return c.json({ ok: true });
  });
  // Soft-delete a conversation (sidebar "删除"). Ownership-checked, then fans
  // out `thread-deleted` so the row vanishes from the sidebar in every window.
  app.delete("/api/threads/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);

    const removed = await softDeleteThread(deps.db, id);
    if (!removed) return c.json({ error: "not found" }, 404);
    deps.clients.publishThreadDeleted(userId, id);
    return c.json({ ok: true });
  });
  app.get("/api/threads/:id/events", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);
    const sinceRaw = Number(c.req.query("since") ?? 0);
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
    return c.json(await listEventsSince(deps.db, id, since));
  });

  // ─── SP-4 Artifacts: chat thread file delivery ───────────────────────────
  // chat has no git boundary, so the deliverable set = the files the runner
  // actually Wrote/Edited this thread (extracted from the tool-call event
  // log). That same allowlist confines the download endpoint — we never read
  // an arbitrary host path, only one the runner is on record as having
  // produced in this thread.

  app.get("/api/threads/:id/files", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);
    const paths = await threadWrittenFiles(deps, id);
    return c.json({ files: paths.map((p) => ({ path: p, name: p.split("/").pop() ?? p })) });
  });

  app.get("/api/threads/:id/file", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);
    const reqPath = c.req.query("path");
    if (!reqPath) return c.json({ error: "path required" }, 400);
    // Allowlist: only files the runner Wrote/Edited in this thread.
    const allow = await threadWrittenFiles(deps, id);
    if (!allow.includes(reqPath)) return c.json({ error: "not a deliverable of this thread" }, 403);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    const session = await getLatestSessionForThread(deps.db, id);
    if (!session?.hostId) return c.json({ error: "no host for thread" }, 409);
    try {
      const file = await deps.projectDomain.readFile(session.hostId, reqPath);
      return artifactFileResponse(c, reqPath, file);
    } catch (err) {
      return c.json({ error: "read failed", detail: String(err) }, 502);
    }
  });

  // Upload a file as agent context for a chat thread. Streams the body to the
  // thread's host (the latest runner session's host if online, else any online
  // host) and stages it under ~/.cogni/uploads/<threadId>/. Returns the host's
  // final (de-duped) name+size; the client references it in the next `send`
  // frame's `attachments`.
  app.post("/api/threads/:id/uploads", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);

    const fileName = decodeURIComponent(c.req.header("X-Filename") ?? "").trim() || "upload";
    const declaredSize = Number(c.req.header("Content-Length") ?? 0) || 0;

    const session = await getLatestSessionForThread(deps.db, id);
    const online = deps.hosts.getOnlineHostsForUser(userId);
    const hostId = online.find((h) => h.hostId === session?.hostId)?.hostId ?? online[0]?.hostId;
    if (!hostId) return c.json({ error: "no host online" }, 409);

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty body" }, 400);

    try {
      const result = await relayUpload({
        hostId, threadId: id, fileName, declaredSize,
        body, sendRpc: sendHostRpc, chunkBytes: 2 * 1024 * 1024,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: "upload failed", detail: String(err) }, 502);
    }
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
                // SP-4: 'workspace' threads route to the orchestrator domain
                // (dispatches with orchestrator:true so the host mounts cogni
                // MCP); everything else stays on the ordinary chat path.
                const kind = await getThreadKind(deps.db, msg.threadId);
                if (kind === "workspace" && deps.workspaceChat) {
                  await deps.workspaceChat.handleClientSend({
                    userId: claims.userId,
                    threadId: msg.threadId,
                    content: msg.text,
                    sourceClientId: clientId,
                    taskId: msg.taskId,
                  });
                } else {
                  await deps.chat.handleClientSend({
                    userId: claims.userId,
                    threadId: msg.threadId,
                    content: msg.text,
                    sourceClientId: clientId,
                    attachments: msg.attachments,
                    model: msg.model,
                  });
                }
              }

              // SP-2 sync variants
              else if (msg.t === "ping") {
                // Heartbeat: bounce a pong so the client keeps the socket alive
                // and the proxy/NAT tunnel stays warm (see ws-client heartbeat).
                deps.clients.sendToConn(clientId, { t: "pong" });
              } else if (msg.t === "subscribe-list") {
                deps.clients.subscribeList(clientId);
              } else if (msg.t === "subscribe-thread") {
                if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) {
                  ws.close(4003, "forbidden");
                  return;
                }
                deps.clients.subscribe(clientId, msg.threadId);
                await streamCatchup(deps, clientId, msg.threadId, msg.lastSeq ?? 0);
                // Tell the client which "/" commands this thread's runner
                // supports so the composer renders the right menu.
                deps.clients.sendToConn(clientId, {
                  t: "thread-commands",
                  threadId: msg.threadId,
                  commands: await deps.chat.commandsForThread(claims.userId, msg.threadId),
                });
              } else if (msg.t === "unsubscribe-thread") {
                deps.clients.unsubscribeThread(clientId, msg.threadId);
              } else if (msg.t === "prewarm") {
                if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) return;
                // Only ordinary chat threads prewarm here. Workspace
                // (orchestrator) threads spawn with --mcp-config + a tool
                // allowlist, so a plain prewarmed process would be the wrong
                // kind — leave those to their normal dispatch.
                const kind = await getThreadKind(deps.db, msg.threadId);
                if (kind !== "workspace") {
                  await deps.chat.handleClientPrewarm({
                    userId: claims.userId,
                    threadId: msg.threadId,
                    model: msg.model,
                  });
                }
              } else if (msg.t === "resolve-fallback") {
                await deps.chat.handleResolveFallback({
                  userId: claims.userId,
                  pendingMessageId: msg.pendingMessageId,
                  action: msg.action,
                  targetHostId: msg.targetHostId ?? null,
                  sourceClientId: clientId,
                });
              } else if (msg.t === "stop") {
                if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) return;
                await deps.chat.handleStop({ userId: claims.userId, threadId: msg.threadId });
              } else if (msg.t === "thread-command") {
                if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) return;
                await deps.chat.handleThreadCommand({
                  userId: claims.userId,
                  threadId: msg.threadId,
                  command: msg.command,
                  sourceClientId: clientId,
                });
              }

              // SP-3 project domain subscriptions. Same pattern as
              // SP-2 subscribe-thread: ownership check (via DB lookup),
              // then register on ClientHub. Cleanup on disconnect is
              // handled by ClientHub.unregister (Track B's sweep covers
              // the new subscription maps).
              // NOTE: ClientHub's subscribe* methods take (clientId, scopeId)
              // — clientId FIRST. An earlier local `ProjectAwareClients`
              // interface declared the args in the opposite order and was
              // bridged with a cast + optional-chaining, which silently
              // mis-registered every subscription (the hub's
              // `clients.has(clientId)` guard saw a projectId/taskId in the
              // clientId slot and bailed, so projectSubs stayed empty and no
              // task-event ever fanned out). We now call deps.clients directly
              // so TS enforces the real signature.
              else if (msg.t === "subscribe-projects") {
                deps.clients.subscribeProjects(clientId, claims.userId);
              } else if (msg.t === "unsubscribe-projects") {
                deps.clients.unsubscribeProjects(clientId, claims.userId);
              } else if (msg.t === "subscribe-project") {
                // Validate ownership: project's userId must match caller.
                const project = await getProject(deps.db, msg.projectId);
                if (!project || project.userId !== claims.userId) {
                  ws.close(4003, "forbidden");
                  return;
                }
                deps.clients.subscribeProject(clientId, msg.projectId);
              } else if (msg.t === "unsubscribe-project") {
                // No ownership check on unsubscribe — idempotent cleanup.
                deps.clients.unsubscribeProject(clientId, msg.projectId);
              } else if (msg.t === "subscribe-task") {
                // Validate ownership: task → parent project → user.
                const task = await getTask(deps.db, msg.taskId);
                if (!task) {
                  ws.close(4003, "forbidden");
                  return;
                }
                const project = await getProject(deps.db, task.projectId);
                if (!project || project.userId !== claims.userId) {
                  ws.close(4003, "forbidden");
                  return;
                }
                deps.clients.subscribeTask(clientId, msg.taskId);
              } else if (msg.t === "unsubscribe-task") {
                deps.clients.unsubscribeTask(clientId, msg.taskId);
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
  // Cold open (no client-side position): seed the message history over this WS
  // so the client doesn't fire a separate HTTP getThread — that request rides a
  // cold connection and pays a full ~1s TLS handshake, whereas this WS is
  // already warm. On reconnects (lastSeq > 0) the client still holds its
  // messages, so we skip the snapshot and only replay the missed event tail.
  // One round-trip: the cold-open message snapshot and the missed event tail
  // are independent reads, so fetch them in parallel instead of three sequential
  // server→DB hops. (Previously: getThreadDetail, then a separate max(seq)
  // precheck, then listEventsSince.) On reconnects (lastSeq > 0) the client
  // already holds its messages, so we skip the snapshot.
  const [detail, rows] = await Promise.all([
    lastSeq === 0 ? getThreadDetail(deps.db, threadId) : Promise.resolve(null),
    listEventsSince(deps.db, threadId, lastSeq),
  ]);
  if (detail) {
    deps.clients.sendToConn(clientId, {
      t: "thread-snapshot", threadId, messages: detail.messages,
    });
  }
  // listEventsSince returns rows ascending by seq; the tail's last seq is the
  // newest the client now has (or its current position if the tail is empty).
  const latestSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : lastSeq;
  if (rows.length > MAX_CATCHUP) {
    deps.clients.sendToConn(clientId, { t: "catchup-too-long", threadId, latestSeq });
    return;
  }
  for (const r of rows) {
    deps.clients.sendToConn(clientId, {
      t: "event", threadId, seq: r.seq, event: r.payload as RunnerEvent,
    });
  }
  deps.clients.sendToConn(clientId, { t: "catchup-complete", threadId, latestSeq });
}
