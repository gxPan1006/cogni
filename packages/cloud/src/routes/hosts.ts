import type { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_RUNNER_ADAPTER_ID } from "@cogni/contract";
import { logger } from "@cogni/shared";
import {
  createHost,
  getActiveHostsForUser,
  renameHost,
  softRemoveHost,
} from "../db/hosts.js";
import { hosts as hostsTable } from "../db/schema.js";
import type { ServerDeps } from "../server.js";

/**
 * SP-2 Runner Host management routes — back the settings page "My Computers"
 * list. All four endpoints are JWT-Bearer authed by the `/api/*` middleware
 * registered in routes/client.ts (so they run inside the same auth context).
 *
 * What the user sees:
 *   • GET   /api/hosts        → settings "My Computers" list, one card per
 *                                non-removed host with name + online dot +
 *                                "Last seen 5m ago".
 *   • POST  /api/hosts        → "Add a new computer" flow returns a
 *                                registration token the desktop Runner uses
 *                                on its first WS handshake.
 *   • PATCH /api/hosts/:id    → in-place rename in the settings card. Other
 *                                connected clients (web + desktop) get a
 *                                live `host-meta` push so the name updates
 *                                everywhere without a refresh.
 *   • DELETE /api/hosts/:id   → "Remove this computer". The cloud
 *                                soft-deletes the row, kicks the live WS
 *                                (so the Runner immediately disconnects),
 *                                and fans out `host-meta status=offline`
 *                                + `device-list-changed` so every other
 *                                end re-fetches and the card disappears.
 *
 * Ownership: every per-id endpoint checks the host belongs to the caller
 * (and isn't soft-removed) before doing anything — cross-user PATCH/DELETE
 * returns 404, never 403, to avoid leaking host-id existence.
 */
export function registerHostsRoutes(app: Hono, deps: ServerDeps): void {
  const renameSchema = z.object({ name: z.string().min(1).max(80) });

  app.get("/api/hosts", async (c) => {
    const { userId } = c.get("claims");
    // SP-2: excludes soft-removed hosts (filter on hosts.removed_at IS NULL).
    const rows = await getActiveHostsForUser(deps.db, userId);
    return c.json(
      rows.map((h) => {
        const live = deps.hosts.getHostByIdForUser(userId, h.id);
        return {
          id: h.id,
          name: h.name,
          status: h.status,
          // ISO string for the UI to render "X 之前"; null when the host has
          // never connected (freshly created, no Runner handshake yet).
          lastSeen: h.lastSeen ? h.lastSeen.toISOString() : null,
          // SP-4: the host's configured projects-root (NewProject pre-fill) and
          // whether it's env-locked. null ⇢ old host that never reported one.
          projectsRoot: h.projectsRoot ?? null,
          projectsRootLocked: h.projectsRootLocked ?? false,
          // Keep-awake toggle state. Defaults ON for hosts that predate the column.
          keepAwake: h.keepAwake ?? true,
          keepAwakeLocked: h.keepAwakeLocked ?? false,
          defaultAdapter: h.defaultAdapter ?? DEFAULT_RUNNER_ADAPTER_ID,
          adapters: live?.adapters ?? [],
        };
      }),
    );
  });

  app.post("/api/hosts", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const body = await c.req.json().catch(() => ({}));
    const name =
      typeof (body as { name?: unknown }).name === "string"
        ? (body as { name: string }).name
        : "My Computer";
    return c.json(await createHost(deps.db, { userId, tenantId, name }));
  });

  app.patch("/api/hosts/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    const owned = await ownedHost(deps.db, id, userId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = renameSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid name" }, 400);

    await renameHost(deps.db, id, parsed.data.name);
    // Push the rename to every connection of this user so the settings card
    // updates live across web + desktop without a manual refresh.
    deps.clients.publishHostMeta(userId, {
      hostId: id,
      name: parsed.data.name,
      status: owned.status as "online" | "offline",
      lastSeen: owned.lastSeen ? owned.lastSeen.toISOString() : null,
    });
    return c.json({ ok: true });
  });

  app.delete("/api/hosts/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    const owned = await ownedHost(deps.db, id, userId);
    if (!owned) return c.json({ error: "not found" }, 404);

    await softRemoveHost(deps.db, id);
    // Kick the in-memory WS so the Runner disconnects immediately and
    // doesn't keep sending dispatches against a removed host.
    try {
      deps.hosts.unregister(id);
    } catch (err) {
      logger.warn({ err: String(err), hostId: id }, "host unregister failed");
    }
    const nowIso = new Date().toISOString();
    // Tell all of this user's clients: this host is gone (now offline) +
    // the device list itself changed (so other end re-pulls /api/hosts and
    // drops the card).
    deps.clients.publishHostMeta(userId, {
      hostId: id,
      name: owned.name,
      status: "offline",
      lastSeen: nowIso,
    });
    deps.clients.publishUserBroadcast(userId, { t: "device-list-changed" });
    return c.json({ ok: true });
  });
}

/**
 * Returns the host row if it belongs to userId and isn't soft-removed,
 * else null. Used by PATCH/DELETE to enforce ownership without leaking
 * host-id existence across users (404 covers both "doesn't exist" and
 * "belongs to someone else").
 */
async function ownedHost(
  db: ServerDeps["db"],
  hostId: string,
  userId: string,
): Promise<typeof hostsTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(hostsTable)
    .where(
      and(
        eq(hostsTable.id, hostId),
        eq(hostsTable.userId, userId),
        isNull(hostsTable.removedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
