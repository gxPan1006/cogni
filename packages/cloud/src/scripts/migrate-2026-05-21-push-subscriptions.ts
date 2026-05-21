/**
 * Migration: create the push_subscriptions table (PWA Web Push).
 *
 * Idempotent — CREATE TABLE / INDEX IF NOT EXISTS. Stores one row per browser
 * push endpoint so the cloud can notify a user's installed PWA when a task
 * reaches done / reviewing / failed, even while the app is closed.
 *
 * MUST run before restarting the cloud on a build that includes push: the
 * /api/push/* routes + the task-state push hook write/read this table, so a
 * missing table would 500 the subscribe path (the push hook itself is
 * try/caught, so it would only log).
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-21-push-subscriptions.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] creating push_subscriptions table…");
await sql`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    locale text not null default 'en',
    user_agent text,
    created_at timestamp not null default now()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id)`;

const post = await sql`SELECT count(*)::int AS subs_n FROM push_subscriptions`;
console.log(`[migrate] done — push_subscriptions=${post[0]?.subs_n}`);
process.exit(0);
