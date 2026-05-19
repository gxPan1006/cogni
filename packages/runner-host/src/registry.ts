import { WebSocket } from "ws";
import type { CloudToHost, HostToCloud, HostRpcRequest, HostRpcResponse, RunnerCapability } from "@cogni/contract";
import { cloudToHostSchema, hostRpcRequestSchema } from "@cogni/contract";
import { logger } from "@cogni/shared";
import { RunnerManager } from "./runner-manager.js";
import type { HostConfig } from "./config.js";

/**
 * SP-3 add-on: optional host-RPC handler injected into `connectToCloud`.
 * Frames that match `hostRpcRequestSchema` (i.e. carry a `method` field) are
 * routed here instead of through `cloudToHostSchema`. Returning undefined is
 * not allowed — the dispatcher always produces a response, even on error.
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
  // SP-3: optional. When provided, frames that pass `hostRpcRequestSchema`
  // are routed here and the response is sent back as a bare JSON-encoded
  // `HostRpcResponse` (no envelope — matches the contract pair). When
  // omitted, RPC frames are ignored, preserving SP-1/SP-2 behavior.
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

    ws.on("open", () => {
      attempt = 0;
      const caps = manager.capabilities();
      send({
        t: "register",
        hostId: config.hostId,
        // `manager.capabilities()` returns `string[]`; the register schema wants
        // `RunnerCapability[]`. Adapters only emit valid capabilities, so this
        // narrowing cast is safe — known type-narrowing seam.
        capabilities: caps.capabilities as RunnerCapability[],
        adapters: caps.adapters,
        version: VERSION,
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
          // SP-3 RPC path: try the host-rpc envelope first. RPC frames carry
          // `method` instead of `t` and are bare (no `t` discriminator), so
          // they would otherwise be rejected by `cloudToHostSchema`. The
          // response shape (`HostRpcResponse`) is also bare — we send it as
          // raw JSON, not wrapped in a `HostToCloud` variant.
          if (rpcHandler) {
            const rpcParsed = hostRpcRequestSchema.safeParse(raw);
            if (rpcParsed.success) {
              const resp = await rpcHandler(rpcParsed.data);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(resp));
              }
              return;
            }
          }
          const parsed = cloudToHostSchema.safeParse(raw);
          if (!parsed.success) return;
          const msg = parsed.data;
          if (msg.t === "dispatch") {
            await handleDispatch(manager, msg, send);
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
