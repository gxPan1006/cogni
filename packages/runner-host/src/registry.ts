import { WebSocket } from "ws";
import type { CloudToHost, HostToCloud, HostRpcRequest, HostRpcResponse, RunnerCapability } from "@cogni/contract";
import { cloudToHostSchema } from "@cogni/contract";
import { logger } from "@cogni/shared";
import { RunnerManager } from "./runner-manager.js";
import { readHostConfig, resolveProjectsRoot } from "./config.js";
import type { HostConfig } from "./config.js";

/**
 * SP-3 add-on: optional host-RPC handler injected into `connectToCloud`.
 * Inbound `host-rpc-request` envelopes (per `cloudToHostSchema`) carry an
 * `rpcId` + nested `request`; the handler receives the unwrapped request and
 * its result is re-wrapped in a matching `host-rpc-response` envelope so
 * concurrent in-flight RPCs over the same WS can be correlated by rpcId.
 */
export type HostRpcHandler = (req: HostRpcRequest) => Promise<HostRpcResponse>;

const HEARTBEAT_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const VERSION = "0.0.0";

/** Pure core: run one dispatch through the manager, emitting host→cloud messages. */
export async function handleDispatch(
  manager: RunnerManager,
  dispatch: Extract<CloudToHost, { t: "dispatch" }>,
  send: (msg: HostToCloud) => void,
): Promise<void> {
  let failed = false;
  await manager.dispatch(dispatch, (event) => {
    if (event.type === "error") failed = true;
    send({ t: "event", sessionId: dispatch.sessionId, event });
  });
  send({
    t: "session-update",
    sessionId: dispatch.sessionId,
    status: failed ? "failed" : "completed",
  });
}

/** Connects to the cloud, registers, runs dispatches, reconnects with backoff. */
export function connectToCloud(
  config: HostConfig,
  manager: RunnerManager,
  // SP-3: optional. When provided, `t: 'host-rpc-request'` envelope frames
  // are unwrapped, dispatched here, and the result wrapped in a matching
  // `host-rpc-response` envelope (echoing `rpcId`) sent back. When omitted,
  // RPC frames are ignored, preserving SP-1/SP-2 behavior.
  rpcHandler?: HostRpcHandler,
): void {
  let attempt = 0;

  const open = () => {
    const url = `${config.cloudUrl}/host/ws?token=${encodeURIComponent(config.registrationToken)}`;
    const ws = new WebSocket(url);
    const send = (msg: HostToCloud) =>
      ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // The `ws` library does not await an async message handler — chain frames
    // per-connection so dispatches are processed in arrival order (the
    // RunnerManager session-handle cache is not concurrency-safe). Mirrors the
    // cloud's host-ws / client WS endpoints.
    let processing: Promise<void> = Promise.resolve();

    ws.on("open", async () => {
      attempt = 0;
      const caps = manager.capabilities();
      const cfg = await readHostConfig();
      const pr = resolveProjectsRoot(cfg?.projectsRoot);
      send({
        t: "register",
        hostId: config.hostId,
        // `manager.capabilities()` returns `string[]`; the register schema wants
        // `RunnerCapability[]`. Adapters only emit valid capabilities, so this
        // narrowing cast is safe — known type-narrowing seam.
        capabilities: caps.capabilities as RunnerCapability[],
        adapters: caps.adapters,
        version: VERSION,
        projectsRoot: pr.root,
        projectsRootLocked: pr.locked,
      });
      heartbeat = setInterval(() => send({ t: "heartbeat" }), HEARTBEAT_MS);
      logger.info({ hostId: config.hostId }, "connected to cloud");
    });

    ws.on("message", (data) => {
      processing = processing
        .then(async () => {
          let raw: unknown;
          try {
            raw = JSON.parse(String(data));
          } catch {
            return; // non-JSON frame — ignore
          }
          const parsed = cloudToHostSchema.safeParse(raw);
          if (!parsed.success) return;
          const msg = parsed.data;
          if (msg.t === "dispatch") {
            await handleDispatch(manager, msg, send);
          } else if (msg.t === "prewarm") {
            // Best-effort: spawn the runner process now so the first dispatch
            // (same sessionId) reuses a warm process instead of cold-starting.
            await manager.prewarm({
              sessionId: msg.sessionId,
              threadId: msg.threadId,
              adapter: msg.adapter,
              runnerSessionId: msg.runnerSessionId,
              ...(msg.model ? { model: msg.model } : {}),
            });
          } else if (msg.t === "host-rpc-request" && rpcHandler) {
            // SP-3: unwrap envelope → dispatch → re-wrap with the same
            // rpcId so the cloud's in-flight RPC table resolves correctly
            // even with concurrent RPCs multiplexed onto one WS.
            const response = await rpcHandler(msg.request);
            if (ws.readyState === WebSocket.OPEN) {
              send({ t: "host-rpc-response", rpcId: msg.rpcId, response });
            }
          }
        })
        .catch((err) => {
          logger.warn(
            { err: String(err), hostId: config.hostId },
            "runner-host message handler failed",
          );
        });
    });

    ws.on("close", () => {
      // `ws` always emits `close` after `error`, so reconnect lives only here.
      if (heartbeat) clearInterval(heartbeat);
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      logger.warn({ delay }, "cloud connection closed; reconnecting");
      setTimeout(open, delay);
    });

    ws.on("error", (err) => logger.error({ err: String(err) }, "cloud connection error"));
  };

  open();
}
