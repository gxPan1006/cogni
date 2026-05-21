import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

// Hand-maintained DDL — MUST stay in sync with schema.ts. Drizzle-kit migrations
// are still aspirational; for now this is the source of truth for pglite tests.
// SP-2 deltas (2026-05-18):
//   • runner_sessions: dropped thread_id UNIQUE, added closed_at
//   • hosts: added removed_at
//   • new auth_sessions table
// SP-3 deltas (2026-05-19):
//   • new projects table
//   • new project_tasks table (depends on projects, hosts, threads)
//   • new task_runs table (depends on project_tasks, runner_sessions)
//   • runner_sessions: added nullable task_id FK (project_tasks)
// Note: runner_sessions is created BEFORE project_tasks so the FK on
// runner_sessions.task_id is added later via ALTER TABLE — postgres won't
// accept a forward reference at CREATE TABLE time.
// 2026-05-20 delta:
//   • threads: added deleted_at (soft delete for sidebar conversation delete)
//   • threads: added kind (SP-4 workspace-chat orchestrator threads)
//   • threads: added project_id (SP-4 multi-session orchestrator scope); FK
//     added via ALTER after projects exists (forward-ref, same as task_id)
//   • users: added password_hash (email+password auth)
//   • messages: added attachments_json (file-upload metadata [{name,size}])
//   • hosts: added projects_root + projects_root_locked (SP-4 default folder)
// 2026-05-21 delta:
//   • hosts: added keep_awake + keep_awake_locked (block-sleep toggle)
const DDL = `
CREATE TABLE tenants (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamp not null default now());
CREATE TABLE users (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), email text not null unique, password_hash text, created_at timestamp not null default now());
CREATE TABLE user_identities (user_id uuid not null references users(id) on delete cascade, kind text not null, sub text not null, created_at timestamp not null default now(), constraint user_identities_pk unique (kind, sub));
CREATE TABLE hosts (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), name text not null, status text not null default 'offline', registration_token text not null unique, capabilities_json jsonb not null default '[]', projects_root text, projects_root_locked boolean not null default false, keep_awake boolean not null default true, keep_awake_locked boolean not null default false, last_seen timestamp, removed_at timestamp, created_at timestamp not null default now());
CREATE TABLE auth_sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id) on delete cascade, device_name text not null, user_agent text, ip text, created_at timestamp not null default now(), last_seen_at timestamp not null default now(), revoked_at timestamp);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE TABLE push_subscriptions (id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id) on delete cascade, endpoint text not null unique, p256dh text not null, auth text not null, locale text not null default 'en', user_agent text, created_at timestamp not null default now());
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);
CREATE TABLE threads (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), title text not null default 'New chat', kind text not null default 'chat', project_id uuid, created_at timestamp not null default now(), updated_at timestamp not null default now(), deleted_at timestamp);
CREATE TABLE messages (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), role text not null, content text not null, created_at timestamp not null default now(), attachments_json jsonb);
CREATE TABLE runner_sessions (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), host_id uuid references hosts(id), adapter text not null, runner_session_id text, status text not null default 'idle', closed_at timestamp, task_id uuid, created_at timestamp not null default now());
CREATE TABLE events (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), session_id uuid not null references runner_sessions(id), seq integer not null, type text not null, payload_json jsonb not null, created_at timestamp not null default now(), constraint events_thread_seq_uq unique (thread_id, seq));
CREATE TABLE projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  name text not null,
  description text,
  repo_path text not null,
  default_host_id uuid not null references hosts(id),
  thread_id uuid references threads(id),
  merge_policy text not null default 'require-review',
  test_command text,
  concurrency_limit integer not null default 2,
  system_prompt text,
  push_to_remote boolean not null default false,
  archived_at timestamp,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);
CREATE INDEX projects_tenant_user_idx ON projects(tenant_id, user_id, archived_at);
CREATE INDEX projects_default_host_idx ON projects(default_host_id);
CREATE TABLE project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  ref text not null,
  title text not null,
  description text,
  state text not null default 'queued',
  priority integer not null default 0,
  labels jsonb not null default '[]',
  order_index text not null,
  host_id uuid references hosts(id),
  adapter text,
  worktree_path text,
  branch_name text,
  execution_thread_id uuid references threads(id),
  retries integer not null default 0,
  max_retries integer not null default 3,
  needs_input_what text,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  started_at timestamp,
  completed_at timestamp,
  constraint project_tasks_project_ref_uq unique (project_id, ref)
);
CREATE INDEX project_tasks_project_state_order_idx ON project_tasks(project_id, state, order_index);
CREATE INDEX project_tasks_host_state_idx ON project_tasks(host_id, state);
ALTER TABLE runner_sessions ADD CONSTRAINT runner_sessions_task_id_fk FOREIGN KEY (task_id) REFERENCES project_tasks(id) ON DELETE SET NULL;
ALTER TABLE threads ADD CONSTRAINT threads_project_id_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
CREATE TABLE task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references project_tasks(id) on delete cascade,
  runner_session_id uuid not null references runner_sessions(id),
  attempt_number integer not null,
  started_at timestamp not null,
  ended_at timestamp,
  exit_reason text,
  error_message text
);
CREATE INDEX task_runs_task_idx ON task_runs(task_id);
CREATE TABLE task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references project_tasks(id) on delete cascade,
  author text not null,
  body text not null,
  state text not null,
  runner_session_id uuid references runner_sessions(id),
  consumed_by_run_id uuid references task_runs(id),
  author_user_id uuid references users(id),
  parent_comment_id uuid,
  attachments_json jsonb,
  created_at timestamp not null default now()
);
CREATE INDEX task_comments_task_created_idx ON task_comments(task_id, created_at);
`;

export async function makeTestDb() {
  const pg = new PGlite();
  await pg.exec(DDL);
  const db = drizzle(pg, { schema });
  return { db, close: () => pg.close() };
}
export type TestDb = Awaited<ReturnType<typeof makeTestDb>>["db"];
