/**
 * SP-2 migration: schema deltas for multi-host + revocable sessions + soft-remove hosts.
 *
 * Idempotent — every statement uses IF NOT EXISTS / DROP IF EXISTS.
 *
 * Schema deltas:
 *   • runner_sessions: drop UNIQUE(thread_id), add closed_at
 *   • hosts: add removed_at (soft delete)
 *   • new table auth_sessions + index
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-18-sp2-deltas.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] dropping runner_sessions.thread_id unique constraint…");
await sql`ALTER TABLE runner_sessions DROP CONSTRAINT IF EXISTS runner_sessions_thread_uq`;

console.log("[migrate] adding runner_sessions.closed_at column…");
await sql`ALTER TABLE runner_sessions ADD COLUMN IF NOT EXISTS closed_at timestamp`;

console.log("[migrate] creating auth_sessions table…");
await sql`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    device_name text not null,
    user_agent text,
    ip text,
    created_at timestamp not null default now(),
    last_seen_at timestamp not null default now(),
    revoked_at timestamp
  )
`;
await sql`CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id) WHERE revoked_at IS NULL`;

console.log("[migrate] adding hosts.removed_at column…");
await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS removed_at timestamp`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM auth_sessions) AS auth_sessions_n,
    (SELECT count(*)::int FROM runner_sessions) AS runner_sessions_n,
    (SELECT count(*)::int FROM hosts WHERE removed_at IS NOT NULL) AS removed_hosts_n
`;
console.log(`[migrate] done — auth_sessions=${post[0]?.auth_sessions_n}, runner_sessions=${post[0]?.runner_sessions_n}, removed_hosts=${post[0]?.removed_hosts_n}`);
process.exit(0);
