import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { hostToCloudSchema } from "@cogni/contract";
import type { CloudToHost } from "@cogni/contract";
import { findHostByToken, setHostStatus } from "../db/hosts.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";

/**
 * Runner Host dials this with ?token=<registrationToken>. First app message
 * must be `register`; thereafter `event` / `session-update` / `heartbeat`.
 */
export function registerHostWs(app: Hono, upgradeWebSocket: UpgradeWebSocket, deps: ServerDeps): void {
  app.get(
    "/host/ws",
    upgradeWebSocket((c) => {
      const token = c.req.query("token") ?? "";
      let hostId: string | null = null;
      let userId: string | null = null;
      let processing: Promise<void> = Promise.resolve();

      return {
        onMessage(evt, ws) {
          // The `ws` library does not await an async onMessage, so streamed
          // frames would interleave. Chain them per-connection so events are
          // processed — and broadcast — in arrival order.
          processing = processing
            .then(async () => {
              let raw: unknown;
              try {
                raw = JSON.parse(String(evt.data));
              } catch {
                return; // non-JSON frame — ignore
              }
              const parsed = hostToCloudSchema.safeParse(raw);
              if (!parsed.success) return;
              const msg = parsed.data;

              if (msg.t === "register") {
                if (hostId) return; // already registered on this socket — idempotent
                const host = await findHostByToken(deps.db, token);
                if (!host) { ws.close(4001, "bad token"); return; }
                hostId = host.id;
                userId = host.userId;
                await setHostStatus(deps.db, host.id, "online", msg.capabilities);
                deps.hosts.register({
                  hostId: host.id,
                  userId: host.userId,
                  send: (m: CloudToHost) => ws.send(JSON.stringify(m)),
                });
                ws.send(JSON.stringify({ t: "registered" } satisfies CloudToHost));
                deps.clients.sendToUser(host.userId, { t: "host-status", online: true });
                logger.info({ hostId, userId }, "runner host registered");
                return;
              }
              if (!hostId) return; // ignore anything before register

              if (msg.t === "heartbeat") {
                await setHostStatus(deps.db, hostId, "online");
              } else if (msg.t === "event") {
                // SP-1: no ownership check that msg.sessionId belongs to this host —
                // SP-1 does not record `host_id` on `runner_sessions` (the column
                // exists but is unwritten), so there's no host→session mapping to
                // check against. One host per user + 256-bit registration tokens
                // bound the exposure; per-session ownership enforcement is an SP-2 concern.
                await deps.chat.handleHostEvent(msg.sessionId, msg.event);
              } else if (msg.t === "session-update") {
                await deps.chat.handleSessionUpdate(msg.sessionId, msg.status);
              }
            })
            .catch((err) => {
              logger.warn({ err: String(err), hostId }, "host-ws onMessage failed");
            });
        },
        async onClose() {
          try {
            if (hostId) {
              deps.hosts.unregister(hostId);
              await setHostStatus(deps.db, hostId, "offline");
              if (userId) deps.clients.sendToUser(userId, { t: "host-status", online: false });
              // SP-1: in-flight `running` runner_sessions for this host are NOT
              // force-failed here — SP-1 does not record `host_id` on
              // `runner_sessions` (the column exists but is unwritten), so there's
              // no host→session mapping yet; and SP-1's chat domain does not gate
              // dispatch on status, so a reconnect self-heals. Proper in-flight-session
              // cleanup (and populating `host_id`) is an SP-2 concern.
              logger.info({ hostId }, "runner host disconnected");
            }
          } catch (err) {
            logger.warn({ err: String(err), hostId }, "host-ws onClose failed");
          }
        },
      };
    }),
  );
}
