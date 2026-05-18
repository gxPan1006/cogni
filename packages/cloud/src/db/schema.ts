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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Auth identities for a user. A user can have multiple identities — e.g.
// Google sign-in AND magic-link sign-in, both pointing at the same user row.
// kind ∈ {'google', 'email', 'dev'}. sub is the issuer-specific subject:
//   google → google `sub` claim
//   email  → lowercased email (1:1 with users.email today; SP-2 may allow secondaries)
//   dev    → 'manual' (only `dev|manual` exists today, written by mint-dev-token)
export const userIdentities = pgTable("user_identities", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  sub: text("sub").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  pk: unique("user_identities_pk").on(t.kind, t.sub),
}));

export const hosts = pgTable("hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("offline"),
  registrationToken: text("registration_token").notNull().unique(),
  capabilitiesJson: jsonb("capabilities_json").notNull().default([]),
  lastSeen: timestamp("last_seen"),
  // SP-2: soft delete. Filter `removedAt IS NULL` in user-visible lookups; keep
  // the row so historic runner_sessions / events keep a valid host_id reference.
  removedAt: timestamp("removed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// SP-2: revocable login sessions backing the settings "Logged-in devices" UI.
// JWTs carry the session id; HTTP middleware + WS handshake look up the row
// and refuse if revoked_at is set.
export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceName: text("device_name").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
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
  // SP-2: when a host switch happens, the old session is marked status='closed'
  // + closed_at=now. The unique-per-thread constraint is dropped — a thread now
  // has many historic sessions, the latest non-closed one is "current".
  closedAt: timestamp("closed_at"),
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
