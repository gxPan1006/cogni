import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { hostToCloudSchema } from "@cogni/contract";
import type { CloudToHost } from "@cogni/contract";
// SP-3 additions for the host-RPC envelope plumbing below.
import type { HostRpcRequest, HostRpcResponse } from "@cogni/contract";
import { findHostByToken, setHostStatus } from "../db/hosts.js";
import { hosts as hostsTable } from "../db/schema.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";

// ─── SP-3 host RPC plumbing ─────────────────────────────────────────────────
//
// The cloud↔host WS is multiplexed: SP-1's `dispatch`/`event` traffic shares
// the socket with SP-3's request/response RPC envelope. To resolve responses
// back to the originating in-flight Promise, we keep a process-wide table
// keyed by rpcId. (Process-wide is fine in SP-3 MVP single-node cloud; SP-3+1
// multi-node will need the orchestrator pinning to the same node that owns
// the host's WS, or routing responses via a shared bus.)
//
// `hostConns` is the (hostId → send-fn) registry sendHostRpc uses to find
// the WS. HostRouter already maintains a userId-scoped one but exposes it
// only through `getHostByIdForUser`; sendHostRpc is called from the
// orchestrator where userId isn't conveniently in scope. Two registries is
// cheap (Map ops are O(1)) and keeps boundaries clean. They stay in sync
// because both register/unregister happen in this file's register / onClose.
const inFlightRpc = new Map<
  string,
  {
    resolve: (resp: HostRpcResponse) => void;
    reject: (err: { code: string; message: string }) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
    hostId: string;
  }
>();
const hostConns = new Map<string, (msg: CloudToHost) => void>();

const DEFAULT_RPC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Send a typed RPC to a connected host and await its response.
 *
 * Resolution rules:
 *   - host offline (not in `hostConns`) → rejects synchronously with
 *     `{ code: "host-offline" }`
 *   - response arrives within timeout → resolves with the host's
 *     `HostRpcResponse` (caller inspects `ok` + narrows on `method`)
 *   - timeout fires first → rejects with `{ code: "rpc-timeout" }`; if the
 *     host's response arrives later, it's silently dropped (entry already
 *     deleted from the table).
 *
 * Callers in `domains/project/host-rpc.ts` wrap the rejection into a typed
 * `HostRpcError`. We keep this function transport-level so the contract
 * (Track A) types and the cloud transport stay decoupled.
 */
export function sendHostRpc(
  hostId: string,
  request: HostRpcRequest,
  opts?: { timeoutMs?: number },
): Promise<HostRpcResponse> {
  const send = hostConns.get(hostId);
  if (!send) {
    return Promise.reject({ code: "host-offline", message: `host ${hostId} offline` });
  }
  const rpcId = randomUUID();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  return new Promise<HostRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      inFlightRpc.delete(rpcId);
      reject({ code: "rpc-timeout", message: `rpc ${request.method} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    // Don't pin the event loop awaiting an RPC reply if the process is
    // otherwise idle (e.g. tests letting node exit).
    timer.unref?.();
    inFlightRpc.set(rpcId, { resolve, reject, timer, method: request.method, hostId });
    try {
      send({ t: "host-rpc-request", rpcId, request });
    } catch (err) {
      clearTimeout(timer);
      inFlightRpc.delete(rpcId);
      reject({ code: "host-send-failed", message: String(err) });
    }
  });
}

/**
 * Test/leak-safety: drop every in-flight RPC. Production paths don't need
 * this — orchestrator stop + host disconnect both clean up via timer +
 * disconnect handlers — but vitest workers reuse modules across tests so the
 * map can leak between specs if we don't expose a reset.
 */
export function _resetHostRpcRegistry(): void {
  for (const entry of inFlightRpc.values()) clearTimeout(entry.timer);
  inFlightRpc.clear();
  hostConns.clear();
}

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
                // SP-3: also pin (hostId → send-fn) for sendHostRpc, which is
                // called from the orchestrator where the userId-scoped HostRouter
                // lookup isn't conveniently in scope. Same shape as HostRouter's
                // send-fn but a separate map so we don't widen HostRouter's API.
                hostConns.set(host.id, (m: CloudToHost) => ws.send(JSON.stringify(m)));
                ws.send(JSON.stringify({ t: "registered" } satisfies CloudToHost));
                // SP-1 broadcast kept for desktop clients pre-upgrade; SP-2
                // host-meta is the precise per-host event new clients prefer.
                deps.clients.sendToUser(host.userId, { t: "host-status", online: true });
                deps.clients.publishHostMeta(host.userId, {
                  hostId: host.id,
                  name: host.name,
                  status: "online",
                  lastSeen: new Date().toISOString(),
                });
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
              } else if (msg.t === "host-rpc-response") {
                // SP-3: resolve the in-flight RPC promise keyed by rpcId. Drop
                // late arrivals silently (entry already deleted by the timeout
                // path). Schema validation already happened in safeParse above,
                // so `msg.response` is a typed `HostRpcResponse`.
                const entry = inFlightRpc.get(msg.rpcId);
                if (entry) {
                  clearTimeout(entry.timer);
                  inFlightRpc.delete(msg.rpcId);
                  entry.resolve(msg.response);
                }
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
              // SP-3: also drop the hostConns pin + fail any in-flight RPCs
              // bound to this host so callers don't hang for the full 5min
              // timeout when we already know the WS is gone.
              hostConns.delete(hostId);
              for (const [rpcId, entry] of inFlightRpc) {
                if (entry.hostId !== hostId) continue;
                clearTimeout(entry.timer);
                inFlightRpc.delete(rpcId);
                entry.reject({ code: "host-offline", message: "host disconnected" });
              }
              await setHostStatus(deps.db, hostId, "offline");
              if (userId) {
                deps.clients.sendToUser(userId, { t: "host-status", online: false });
                // SP-2: publish a precise per-host offline event so settings UIs
                // and Conversation's fallback card recompute live. Re-fetch the
                // name in case it was renamed mid-connection.
                const row = await deps.db.select({ name: hostsTable.name })
                  .from(hostsTable).where(eq(hostsTable.id, hostId)).limit(1);
                deps.clients.publishHostMeta(userId, {
                  hostId,
                  name: row[0]?.name ?? "Unknown",
                  status: "offline",
                  lastSeen: new Date().toISOString(),
                });
              }
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
