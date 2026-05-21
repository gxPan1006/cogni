/**
 * Migration: add `parent_comment_id` to task_comments (comment replies).
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS. Stores the id of the comment a reply
 * targets (or NULL for a top-level note). Plain column (no FK): a dangling id
 * after the parent is deleted is harmless — the UI just drops the reference.
 *
 * MUST run after migrate-2026-05-21-task-comments.ts (the table) and before
 * restarting the cloud on a build that reads/writes comment replies.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-21-task-comment-parent.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding task_comments.parent_comment_id…");
await sql`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS parent_comment_id uuid`;

console.log("[migrate] done — task_comments.parent_comment_id present");
