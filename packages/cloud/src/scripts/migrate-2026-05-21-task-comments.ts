/**
 * Migration: create the task_comments table (主页面 comment feed).
 *
 * Idempotent — CREATE TABLE / INDEX IF NOT EXISTS. Stores worker handoff notes
 * (author='worker', captured at lifecycle transitions) and inert human notes
 * (author='user', injected into the runner context only once consumed_by_run_id
 * is stamped).
 *
 * MUST run before restarting the cloud on a build that includes the task
 * comment feature: the comment routes + worker-note capture write/read this
 * table, so a missing table would 500 those paths.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-21-task-comments.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] creating task_comments table…");
await sql`
  CREATE TABLE IF NOT EXISTS task_comments (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references project_tasks(id) on delete cascade,
    author text not null,
    body text not null,
    state text not null,
    runner_session_id uuid references runner_sessions(id),
    consumed_by_run_id uuid references task_runs(id),
    author_user_id uuid references users(id),
    created_at timestamp not null default now()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS task_comments_task_created_idx ON task_comments(task_id, created_at)`;

const post = await sql`SELECT count(*)::int AS comments_n FROM task_comments`;
console.log(`[migrate] done — task_comments=${post[0]?.comments_n}`);
process.exit(0);
