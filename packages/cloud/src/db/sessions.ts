import { eq, and, gt, asc, sql } from "drizzle-orm";
import { runnerSessions, events } from "./schema.js";
import type { AnyDb } from "./users.js";
import type { RunnerEvent, EventView, RunnerSessionStatus } from "@cogni/contract";

export interface RunnerSessionRow {
  id: string;
  threadId: string;
  adapter: string;
  runnerSessionId: string | null;
  status: RunnerSessionStatus;
}

export async function getOrCreateRunnerSession(
  db: AnyDb,
  threadId: string,
  adapter: string,
): Promise<RunnerSessionRow> {
  const existing = await db
    .select()
    .from(runnerSessions)
    .where(eq(runnerSessions.threadId, threadId))
    .limit(1);
  if (existing[0]) return toRow(existing[0]);
  const [row] = await db
    .insert(runnerSessions)
    .values({ threadId, adapter })
    .returning();
  return toRow(row!);
}

export async function getRunnerSessionById(db: AnyDb, sessionId: string): Promise<RunnerSessionRow | null> {
  const rows = await db.select().from(runnerSessions).where(eq(runnerSessions.id, sessionId)).limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function setRunnerSessionId(db: AnyDb, sessionId: string, runnerSessionId: string) {
  await db.update(runnerSessions).set({ runnerSessionId }).where(eq(runnerSessions.id, sessionId));
}

export async function setRunnerSessionStatus(db: AnyDb, sessionId: string, status: RunnerSessionStatus) {
  await db.update(runnerSessions).set({ status }).where(eq(runnerSessions.id, sessionId));
}

/**
 * Append one event to a thread's stream, assigning the next per-thread `seq`.
 * Per-connection message processing is serialized in the host WS endpoint, so
 * events from a given host are appended in arrival order; the
 * `events_thread_seq_uq` constraint is the backstop if concurrency ever breaks
 * that assumption (e.g. multiple hosts, SP-2).
 */
export async function appendEvent(
  db: AnyDb,
  input: { threadId: string; sessionId: string; event: RunnerEvent },
): Promise<EventView> {
  const nextSeq = sql<number>`(SELECT COALESCE(MAX(${events.seq}), 0) + 1 FROM ${events} WHERE ${events.threadId} = ${input.threadId})`;
  const [row] = await db
    .insert(events)
    .values({
      threadId: input.threadId,
      sessionId: input.sessionId,
      seq: nextSeq,
      type: input.event.type,
      payloadJson: input.event,
    })
    .returning();
  return { seq: row!.seq, type: row!.type, payload: row!.payloadJson, createdAt: row!.createdAt.toISOString() };
}

export async function listEventsSince(db: AnyDb, threadId: string, sinceSeq: number): Promise<EventView[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.threadId, threadId), gt(events.seq, sinceSeq)))
    .orderBy(asc(events.seq));
  return rows.map((r) => ({
    seq: r.seq,
    type: r.type,
    payload: r.payloadJson,
    createdAt: r.createdAt.toISOString(),
  }));
}

function toRow(r: typeof runnerSessions.$inferSelect): RunnerSessionRow {
  return {
    id: r.id,
    threadId: r.threadId,
    adapter: r.adapter,
    runnerSessionId: r.runnerSessionId,
    status: r.status as RunnerSessionStatus,
  };
}
