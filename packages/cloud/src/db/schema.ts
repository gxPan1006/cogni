import { pgTable, uuid, text, timestamp, integer, jsonb, unique } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  email: text("email").notNull().unique(),
  oauthSub: text("oauth_sub").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const hosts = pgTable("hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("offline"),
  registrationToken: text("registration_token").notNull().unique(),
  capabilitiesJson: jsonb("capabilities_json").notNull().default([]),
  lastSeen: timestamp("last_seen"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  title: text("title").notNull().default("New chat"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const runnerSessions = pgTable("runner_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  hostId: uuid("host_id").references(() => hosts.id),
  adapter: text("adapter").notNull(),
  runnerSessionId: text("runner_session_id"),
  status: text("status").notNull().default("idle"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  sessionId: uuid("session_id").notNull().references(() => runnerSessions.id),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payloadJson: jsonb("payload_json").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  threadSeq: unique("events_thread_seq_uq").on(t.threadId, t.seq),
}));
