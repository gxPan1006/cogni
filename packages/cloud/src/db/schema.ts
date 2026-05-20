import { pgTable, uuid, text, timestamp, integer, jsonb, unique, index, boolean } from "drizzle-orm/pg-core";

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
  // Soft delete (matches hosts.removed_at / projects.archived_at): a deleted
  // thread keeps its messages/events/runner_sessions rows intact (those FK
  // back to threads with no cascade) but disappears from every list + lookup.
  deletedAt: timestamp("deleted_at"),
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
  // SP-3: nullable FK to project_tasks. NULL ⇢ chat session (SP-1/SP-2 path);
  // non-NULL ⇢ project task session. ON DELETE SET NULL so deleting a task
  // doesn't cascade to event history (events keep referencing the session).
  // Forward-references `projectTasks` defined below; drizzle resolves via the
  // thunk-style reference callback so declaration order doesn't matter.
  taskId: uuid("task_id").references((): any => projectTasks.id, { onDelete: "set null" }),
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

// ─── SP-3 project domain ────────────────────────────────────────────────────

/**
 * A user-owned project rooted at one git repo on one default host. Soft-delete
 * via `archivedAt`. `concurrencyLimit` caps simultaneous running tasks within
 * this project (1-16, validated at the contract layer). `mergePolicy` selects
 * the post-runner gate (require-review | auto-merge | auto-merge-if-tests-pass).
 */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  repoPath: text("repo_path").notNull(),
  defaultHostId: uuid("default_host_id").notNull().references(() => hosts.id),
  // SP-3 reserves; SP-4 Workspace Chat will write here. Nullable until then.
  threadId: uuid("thread_id").references(() => threads.id),
  mergePolicy: text("merge_policy").notNull().default("require-review"),
  testCommand: text("test_command"),
  concurrencyLimit: integer("concurrency_limit").notNull().default(2),
  systemPrompt: text("system_prompt"),
  // SP-3+1: push main to origin after a task merges (see Project.pushToRemote).
  pushToRemote: boolean("push_to_remote").notNull().default(false),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  byUser: index("projects_tenant_user_idx").on(t.tenantId, t.userId, t.archivedAt),
  byHost: index("projects_default_host_idx").on(t.defaultHostId),
}));

/**
 * One task inside a project. `ref` is the human-readable code ("MYAPP-1");
 * `(projectId, ref)` is unique. `orderIndex` is stored as text so the UI can
 * insert between siblings with lexicographic fractional keys (e.g. "1", "1.5",
 * "2") — chosen over numeric to avoid float precision drift; comparison
 * happens by parsing client-side or `(text::numeric)` in SQL when ordering.
 * `labels` is jsonb-encoded `string[]` (drizzle has no native pg text[] helper
 * across PGlite + neon-serverless consistently; jsonb gives us portable
 * arrays + identical query ergonomics).
 */
export const projectTasks = pgTable("project_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  ref: text("ref").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  state: text("state").notNull().default("queued"),
  priority: integer("priority").notNull().default(0),
  labels: jsonb("labels").notNull().default([]),
  orderIndex: text("order_index").notNull(),
  hostId: uuid("host_id").references(() => hosts.id),
  adapter: text("adapter"),
  worktreePath: text("worktree_path"),
  branchName: text("branch_name"),
  executionThreadId: uuid("execution_thread_id").references(() => threads.id),
  retries: integer("retries").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  needsInputWhat: text("needs_input_what"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (t) => ({
  byProjectStateOrder: index("project_tasks_project_state_order_idx").on(t.projectId, t.state, t.orderIndex),
  byHostState: index("project_tasks_host_state_idx").on(t.hostId, t.state),
  refUq: unique("project_tasks_project_ref_uq").on(t.projectId, t.ref),
}));

/**
 * Audit row for every `queued → running` transition of a task. Resume reuses
 * the existing run; retry creates a new one with incremented `attemptNumber`.
 * `exitReason` enumerated values match the contract `TaskExitReason` union.
 */
export const taskRuns = pgTable("task_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => projectTasks.id, { onDelete: "cascade" }),
  runnerSessionId: uuid("runner_session_id").notNull().references(() => runnerSessions.id),
  attemptNumber: integer("attempt_number").notNull(),
  startedAt: timestamp("started_at").notNull(),
  endedAt: timestamp("ended_at"),
  exitReason: text("exit_reason"),
  errorMessage: text("error_message"),
}, (t) => ({
  byTask: index("task_runs_task_idx").on(t.taskId),
}));
