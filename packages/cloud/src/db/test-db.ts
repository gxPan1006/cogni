import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

// Hand-maintained DDL — MUST stay in sync with schema.ts. Drizzle-kit migrations
// are still aspirational; for now this is the source of truth for pglite tests.
// SP-2 deltas (2026-05-18):
//   • runner_sessions: dropped thread_id UNIQUE, added closed_at
//   • hosts: added removed_at
//   • new auth_sessions table
const DDL = `
CREATE TABLE tenants (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamp not null default now());
CREATE TABLE users (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), email text not null unique, created_at timestamp not null default now());
CREATE TABLE user_identities (user_id uuid not null references users(id) on delete cascade, kind text not null, sub text not null, created_at timestamp not null default now(), constraint user_identities_pk unique (kind, sub));
CREATE TABLE hosts (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), name text not null, status text not null default 'offline', registration_token text not null unique, capabilities_json jsonb not null default '[]', last_seen timestamp, removed_at timestamp, created_at timestamp not null default now());
CREATE TABLE auth_sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id) on delete cascade, device_name text not null, user_agent text, ip text, created_at timestamp not null default now(), last_seen_at timestamp not null default now(), revoked_at timestamp);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE TABLE threads (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), title text not null default 'New chat', created_at timestamp not null default now(), updated_at timestamp not null default now());
CREATE TABLE messages (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), role text not null, content text not null, created_at timestamp not null default now());
CREATE TABLE runner_sessions (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), host_id uuid references hosts(id), adapter text not null, runner_session_id text, status text not null default 'idle', closed_at timestamp, created_at timestamp not null default now());
CREATE TABLE events (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), session_id uuid not null references runner_sessions(id), seq integer not null, type text not null, payload_json jsonb not null, created_at timestamp not null default now(), constraint events_thread_seq_uq unique (thread_id, seq));
`;

export async function makeTestDb() {
  const pg = new PGlite();
  await pg.exec(DDL);
  const db = drizzle(pg, { schema });
  return { db, close: () => pg.close() };
}
export type TestDb = Awaited<ReturnType<typeof makeTestDb>>["db"];
