/**
 * Migration: add threads.project_id for multi-session orchestrator chat.
 *
 * SP-4 originally linked a project to ONE orchestrator thread via
 * `projects.thread_id` (1:1). The floating chat bubble lets a project (or the
 * workspace) own MANY orchestrator sessions, so scope detection now reads
 * `threads.project_id` instead. We backfill it from the legacy
 * `projects.thread_id` pointer so existing project chats keep their scope.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS + UPDATE only the still-null rows.
 * ON DELETE SET NULL: hard-deleting a project orphans its chat history as
 * workspace-level threads rather than blocking the delete.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-20-thread-project-id.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding threads.project_id column…");
await sql`
  ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS project_id uuid
  REFERENCES projects(id) ON DELETE SET NULL
`;

console.log("[migrate] backfilling project_id from projects.thread_id…");
await sql`
  UPDATE threads t
  SET project_id = p.id
  FROM projects p
  WHERE p.thread_id = t.id AND t.project_id IS NULL
`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM threads) AS threads_n,
    (SELECT count(*)::int FROM threads WHERE project_id IS NOT NULL) AS scoped_n
`;
console.log(`[migrate] done — threads=${post[0]?.threads_n}, project-scoped=${post[0]?.scoped_n}`);
process.exit(0);
