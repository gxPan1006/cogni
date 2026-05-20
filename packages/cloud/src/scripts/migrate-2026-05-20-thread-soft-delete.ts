/**
 * Migration: add threads.deleted_at for sidebar conversation delete.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS. A non-null deleted_at hides the
 * thread from listThreads / getThreadDetail / threadBelongsToUser while its
 * messages/events/runner_sessions rows (which FK back to threads with no
 * cascade) stay intact.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-20-thread-soft-delete.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding threads.deleted_at column…");
await sql`ALTER TABLE threads ADD COLUMN IF NOT EXISTS deleted_at timestamp`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM threads) AS threads_n,
    (SELECT count(*)::int FROM threads WHERE deleted_at IS NOT NULL) AS deleted_n
`;
console.log(`[migrate] done — threads=${post[0]?.threads_n}, deleted=${post[0]?.deleted_n}`);
process.exit(0);
