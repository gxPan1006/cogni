import { z } from "zod";
import { runnerEventSchema, RUNNER_CAPABILITIES } from "./runner.js";

export const sessionStatusSchema = z.enum(["running", "completed", "failed"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

// ---- Runner Host → Cloud ----
export const hostToCloudSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("register"),
    hostId: z.string(),
    capabilities: z.array(z.enum(RUNNER_CAPABILITIES)),
    adapters: z.array(z.string()),
    version: z.string(),
  }),
  z.object({ t: z.literal("heartbeat") }),
  z.object({ t: z.literal("event"), sessionId: z.string(), event: runnerEventSchema }),
  z.object({ t: z.literal("session-update"), sessionId: z.string(), status: sessionStatusSchema }),
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
  }),
]);
export type CloudToHost = z.infer<typeof cloudToHostSchema>;

// ---- Client → Cloud ----
export const clientToCloudSchema = z.discriminatedUnion("t", [
  // SP-1 legacy (kept for compatibility while old clients are around)
  z.object({ t: z.literal("subscribe"), threadId: z.string() }),
  z.object({ t: z.literal("send"), threadId: z.string(), text: z.string() }),
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
  }),
  z.object({ t: z.literal("host-status"), online: z.boolean() }),
  z.object({ t: z.literal("error"), message: z.string() }),
  // SP-2 sync
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
  // SP-2 dispatch responses
  z.object({
    t: z.literal("host-fallback-prompt"),
    pendingMessageId: z.string(),
    preferred: z.object({ id: z.string(), name: z.string(), lastSeenAgoMs: z.number() }),
    alternatives: z.array(z.object({ id: z.string(), name: z.string(), lastSeenAgoMs: z.number() })),
  }),
  z.object({ t: z.literal("no-host-online"), pendingMessageId: z.string() }),
]);
export type CloudToClient = z.infer<typeof cloudToClientSchema>;
