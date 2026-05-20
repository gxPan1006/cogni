export type Role = "user" | "assistant" | "system";
export type RunnerSessionStatus = "idle" | "running" | "completed" | "failed" | "closed";
export type HostConnState = "online" | "offline";

/** GET /api/threads */
export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
}
/** GET /api/threads/:id */
export interface ThreadDetail {
  id: string;
  title: string;
  messages: MessageView[];
}
export interface MessageView {
  id: string;
  threadId: string;
  role: Role;
  content: string;
  createdAt: string;
  attachments?: { name: string; size: number }[];
}
/** GET /api/threads/:id/events?since=N */
export interface EventView {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}
/** POST /api/hosts response */
export interface HostRegistration {
  hostId: string;
  registrationToken: string;
}
