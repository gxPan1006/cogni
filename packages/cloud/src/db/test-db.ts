import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

// TODO(SP-2): replace with drizzle-kit generated migration. Until then this DDL
// is hand-maintained and MUST stay in sync with schema.ts — drift will make
// repository tests pass against a stale schema.
const DDL = `
CREATE TABLE tenants (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamp not null default now());
CREATE TABLE users (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), email text not null unique, created_at timestamp not null default now());
CREATE TABLE user_identities (user_id uuid not null references users(id) on delete cascade, kind text not null, sub text not null, created_at timestamp not null default now(), constraint user_identities_pk unique (kind, sub));
CREATE TABLE hosts (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), name text not null, status text not null default 'offline', registration_token text not null unique, capabilities_json jsonb not null default '[]', last_seen timestamp, created_at timestamp not null default now());
CREATE TABLE threads (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), title text not null default 'New chat', created_at timestamp not null default now(), updated_at timestamp not null default now());
CREATE TABLE messages (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), role text not null, content text not null, created_at timestamp not null default now());
CREATE TABLE runner_sessions (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), host_id uuid references hosts(id), adapter text not null, runner_session_id text, status text not null default 'idle', created_at timestamp not null default now(), constraint runner_sessions_thread_uq unique (thread_id));
CREATE TABLE events (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), session_id uuid not null references runner_sessions(id), seq integer not null, type text not null, payload_json jsonb not null, created_at timestamp not null default now(), constraint events_thread_seq_uq unique (thread_id, seq));
`;

export async function makeTestDb() {
  const pg = new PGlite();
  await pg.exec(DDL);
  const db = drizzle(pg, { schema });
  return { db, close: () => pg.close() };
}
export type TestDb = Awaited<ReturnType<typeof makeTestDb>>["db"];
