import { z } from "zod";
import { runnerEventSchema, RUNNER_CAPABILITIES } from "./runner.js";
import {
  projectSchema,
  projectTaskSchema,
  projectEventKindSchema,
  taskEventKindSchema,
  taskCommentSchema,
} from "./project.js";
import { hostRpcRequestSchema, hostRpcResponseSchema } from "./host-protocol.js";

export const sessionStatusSchema = z.enum(["running", "completed", "failed"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** Lightweight attachment metadata carried on send/dispatch/message frames. */
export const attachmentSchema = z.object({
  name: z.string(),
  size: z.number().int().min(0),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * Curated Claude model list for the composer's model picker. Claude Code's CLI
 * exposes no model-enumeration API, so we ship the known current tiers; the
 * chosen `id` rides the `send` → `dispatch` frames and the runner-host adapter
 * passes it as `claude --model <id>`. Keep `id`s as the CLI-accepted aliases.
 */
export const CHAT_MODELS = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
] as const;
export type ChatModelId = (typeof CHAT_MODELS)[number]["id"];
export const DEFAULT_CHAT_MODEL: ChatModelId = "claude-opus-4-7";

/** One persisted chat message — same shape as the HTTP `getThread` row, so the
 *  client treats a WS `thread-snapshot` and an HTTP reload interchangeably. */
export const messageViewSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string(),
  attachments: z.array(attachmentSchema).optional(),
});

// ---- Runner Host → Cloud ----
export const hostToCloudSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("register"),
    hostId: z.string(),
    capabilities: z.array(z.enum(RUNNER_CAPABILITIES)),
    adapters: z.array(z.string()),
    version: z.string(),
    /** SP-4: host's configured projects-root (absolute, ~-expanded). Optional for old hosts. */
    projectsRoot: z.string().optional(),
    /** true ⇢ root pinned by COGNI_PROJECTS_ROOT env (UI shows read-only). */
    projectsRootLocked: z.boolean().optional(),
    /** Whether the host blocks OS sleep while alive. Optional for old hosts. */
    keepAwake: z.boolean().optional(),
    /** true ⇢ pinned by COGNI_KEEP_AWAKE env (UI shows the toggle read-only). */
    keepAwakeLocked: z.boolean().optional(),
  }),
  z.object({ t: z.literal("heartbeat") }),
  z.object({ t: z.literal("event"), sessionId: z.string(), event: runnerEventSchema }),
  z.object({ t: z.literal("session-update"), sessionId: z.string(), status: sessionStatusSchema }),
  // SP-3 host RPC response envelope. The host wraps a typed `hostRpcResponse`
  // payload (success branch carries the typed result; error branch carries
  // ok:false + message). `rpcId` echoes the request so the cloud can resolve
  // the in-flight RPC table even when multiple RPCs are in flight on the
  // single host WS.
  z.object({
    t: z.literal("host-rpc-response"),
    rpcId: z.string(),
    response: hostRpcResponseSchema,
  }),
]);
export type HostToCloud = z.infer<typeof hostToCloudSchema>;

// ---- Cloud → Runner Host ----
export const cloudToHostSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("registered") }),
  z.object({
    t: z.literal("dispatch"),
    sessionId: z.string(),
    threadId: z.string(),
    adapter: z.string(),
    runnerSessionId: z.string().nullable(),
    message: z.string(),
    /**
     * SP-3: project-task worktree path. The host overrides the adapter's
     * cwd to this when present; chat dispatches omit it and the host falls
     * back to the per-thread scratch dir (SP-1 behavior). Optional to stay
     * backward-compatible with SP-1/SP-2 chat-only clients.
     */
    workspacePath: z.string().optional(),
    /**
     * SP-4: marks an orchestrator (Workspace Chat) dispatch. The host mounts
     * the cogni MCP server (`--mcp-config`) and restricts tools to cogni__*.
     * Optional; absent for ordinary chat/task dispatches.
     */
    orchestrator: z.boolean().optional(),
    /**
     * SP-4: extra system-prompt text for the runner turn (orchestrator
     * preamble). The host passes it as `--append-system-prompt`. Sent on
     * every orchestrator turn so resumed sessions keep the framing.
     */
    appendSystemPrompt: z.string().optional(),
    /**
     * Files the user attached this turn. The host copies them from its staging
     * dir into <cwd>/.cogni-uploads/ before running, and the cloud has already
     * prepended a preamble to `message` pointing at them. Optional/absent for
     * turns with no attachments.
     */
    attachments: z.array(attachmentSchema).optional(),
    /**
     * Chat model the user picked in the composer (a CHAT_MODELS id). The host
     * passes it as `claude --model <id>`; absent ⇒ the CLI's default model.
     */
    model: z.string().optional(),
  }),
  // Prewarm: spawn the runner process for `sessionId` ahead of the first
  // dispatch so its ~1.9s CLI cold start is paid while the user is still
  // composing. Carries no `message` — the prompt arrives on the later
  // `dispatch`, which reuses the same `sessionId` (and thus the warm process).
  z.object({
    t: z.literal("prewarm"),
    sessionId: z.string(),
    threadId: z.string(),
    adapter: z.string(),
    runnerSessionId: z.string().nullable(),
    model: z.string().optional(),
  }),
  // SP-3 host RPC request envelope. The cloud assigns `rpcId`; the host
  // echoes it on the `host-rpc-response` frame. `request` is the typed
  // method+params union from host-protocol.ts.
  z.object({
    t: z.literal("host-rpc-request"),
    rpcId: z.string(),
    request: hostRpcRequestSchema,
  }),
]);
export type CloudToHost = z.infer<typeof cloudToHostSchema>;

// ---- Client → Cloud ----
export const clientToCloudSchema = z.discriminatedUnion("t", [
  // SP-1 legacy (kept for compatibility while old clients are around)
  z.object({ t: z.literal("subscribe"), threadId: z.string() }),
  z.object({
    t: z.literal("send"),
    threadId: z.string(),
    text: z.string(),
    attachments: z.array(attachmentSchema).optional(),
    // SP-4: an orchestrator (`workspace` thread) send may carry the task the
    // user is currently focused on (the last task card they opened on this
    // board). The cloud folds it into the runner's --append-system-prompt so
    // the model knows which card "this" / "改一下" refers to.
    taskId: z.string().optional(),
    /** Chat model the user picked in the composer (a CHAT_MODELS id). */
    model: z.string().optional(),
  }),
  // Prewarm hint: the user opened a fresh chat / started composing on a thread.
  // The cloud spawns the runner process ahead of the first `send` so the first
  // token isn't gated on the CLI cold start. Idempotent + best-effort — safe to
  // send (debounced) on composer focus / first keystroke. Ignored for threads
  // with no online host.
  z.object({ t: z.literal("prewarm"), threadId: z.string(), model: z.string().optional() }),
  // Heartbeat: keeps the WS — and the proxy/NAT tunnel it rides — warm so the
  // first frame after an idle pause isn't slow, and lets the client detect a
  // silently half-dead socket fast (no `pong` back ⇒ reconnect). Cloud replies
  // with `pong`.
  z.object({ t: z.literal("ping") }),
  // SP-2
  z.object({ t: z.literal("subscribe-list") }),
  z.object({ t: z.literal("subscribe-thread"), threadId: z.string(), lastSeq: z.number().optional() }),
  z.object({ t: z.literal("unsubscribe-thread"), threadId: z.string() }),
  z.object({
    t: z.literal("resolve-fallback"),
    pendingMessageId: z.string(),
    action: z.enum(["switch", "cancel"]),
    targetHostId: z.string().optional(),
  }),
  // SP-3 project domain subscriptions (one WS, N subscriptions; reconnect
  // resubscribes automatically — same pattern as SP-2 thread subs).
  z.object({ t: z.literal("subscribe-projects") }),
  z.object({ t: z.literal("unsubscribe-projects") }),
  z.object({ t: z.literal("subscribe-project"), projectId: z.string() }),
  z.object({ t: z.literal("unsubscribe-project"), projectId: z.string() }),
  z.object({ t: z.literal("subscribe-task"), taskId: z.string() }),
  z.object({ t: z.literal("unsubscribe-task"), taskId: z.string() }),
]);
export type ClientToCloud = z.infer<typeof clientToCloudSchema>;

// ---- Cloud → Client ----
export const cloudToClientSchema = z.discriminatedUnion("t", [
  // SP-1 legacy events
  z.object({ t: z.literal("event"), threadId: z.string(), seq: z.number(), event: runnerEventSchema }),
  z.object({
    t: z.literal("message"),
    threadId: z.string(),
    messageId: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    createdAt: z.string(),
    attachments: z.array(attachmentSchema).optional(),
  }),
  z.object({ t: z.literal("host-status"), online: z.boolean() }),
  z.object({ t: z.literal("error"), message: z.string() }),
  // Heartbeat reply to the client's `ping` (see clientToCloud). Carries no data —
  // its arrival is the liveness signal the client uses to keep/declare the socket.
  z.object({ t: z.literal("pong") }),
  // SP-2 sync
  // Cold-open message history pushed over the same WS as the event catchup, so
  // the client skips a separate (and often cold, ~1s) HTTP getThread on click.
  // Sent only when the client subscribes from lastSeq 0 (a fresh open); on
  // reconnects (lastSeq > 0) the client already holds the messages.
  z.object({ t: z.literal("thread-snapshot"), threadId: z.string(), messages: z.array(messageViewSchema) }),
  z.object({ t: z.literal("catchup-complete"), threadId: z.string(), latestSeq: z.number() }),
  z.object({ t: z.literal("catchup-too-long"), threadId: z.string(), latestSeq: z.number() }),
  z.object({ t: z.literal("thread-meta"), threadId: z.string(), title: z.string(), lastMsgAt: z.string() }),
  z.object({
    t: z.literal("thread-created"),
    thread: z.object({ id: z.string(), title: z.string(), updatedAt: z.string() }),
  }),
  z.object({ t: z.literal("thread-deleted"), threadId: z.string() }),
  // SP-2 user-level
  z.object({ t: z.literal("device-list-changed") }),
  z.object({
    t: z.literal("host-meta"),
    hostId: z.string(),
    name: z.string(),
    status: z.enum(["online", "offline"]),
    lastSeen: z.string().nullable(),
  }),
  // SP-2 dispatch responses. `threadId` is carried so the client (which now
  // multiplexes many threads onto one WS) can route the response to the right
  // per-thread state without relying on send-order correlation.
  z.object({
    t: z.literal("host-fallback-prompt"),
    threadId: z.string(),
    pendingMessageId: z.string(),
    preferred: z.object({ id: z.string(), name: z.string(), lastSeenAgoMs: z.number() }),
    alternatives: z.array(z.object({ id: z.string(), name: z.string(), lastSeenAgoMs: z.number() })),
  }),
  z.object({ t: z.literal("no-host-online"), threadId: z.string(), pendingMessageId: z.string() }),
  // SP-3 project domain pushes. `project-event` fires for list-level
  // changes (sidebar / ProjectsList); `task-event` fires for board-level
  // changes (kanban card state, drag-reorder, etc). Task runner events
  // — the per-tool-call stream the drawer renders — continue to flow on
  // the existing `event` channel (re-using the task's executionThreadId
  // as `threadId`); subscribers to `subscribe-task` resolve the taskId
  // → threadId mapping client-side.
  z.object({
    t: z.literal("project-event"),
    kind: projectEventKindSchema,
    project: projectSchema,
  }),
  z.object({
    t: z.literal("task-event"),
    kind: taskEventKindSchema,
    task: projectTaskSchema,
  }),
  // SP-3 task comment feed (主页面). Routed to per-task subscribers only —
  // the board does not render comments. `kind: "deleted"` carries the row
  // whose `id` was removed.
  z.object({
    t: z.literal("task-comment"),
    kind: z.enum(["created", "deleted"]),
    comment: taskCommentSchema,
  }),
]);
export type CloudToClient = z.infer<typeof cloudToClientSchema>;
