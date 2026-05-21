/**
 * Migration: add `attachments_json` to task_comments (comment file uploads).
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS. Stores [{name,size}] of files the user
 * attached to an inert human note; the files are staged on the host under the
 * task's executionThreadId and materialized into the worktree at the next
 * dispatch (same pattern as messages.attachments_json).
 *
 * MUST run after migrate-2026-05-21-task-comments.ts (the table) and before
 * restarting the cloud on a build that reads/writes comment attachments.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-21-task-comments-attachments.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding task_comments.attachments_json…");
await sql`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS attachments_json jsonb`;

console.log("[migrate] done — task_comments.attachments_json present");
