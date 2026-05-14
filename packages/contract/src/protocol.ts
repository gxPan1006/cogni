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
  z.object({ t: z.literal("subscribe"), threadId: z.string() }),
  z.object({ t: z.literal("send"), threadId: z.string(), text: z.string() }),
]);
export type ClientToCloud = z.infer<typeof clientToCloudSchema>;

// ---- Cloud → Client ----
export const cloudToClientSchema = z.discriminatedUnion("t", [
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
]);
export type CloudToClient = z.infer<typeof cloudToClientSchema>;
