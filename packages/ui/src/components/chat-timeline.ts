/**
 * chat-timeline — pure (React-free, CSS-free) logic for turning a thread's
 * persisted message rows + flat RunnerEvent[] stream into a renderable
 * timeline. Kept in its own module so the conversation reducers can be
 * unit-tested under the `node` vitest environment (importing the .tsx that
 * pulls in `chat-blocks.css` would break that).
 *
 * Two layers:
 *   - `aggregateEvents(events)`  — one assistant turn's events → ordered Blocks
 *     (text deltas concatenated, tool-call paired with tool-result by toolId).
 *   - `buildTimeline(messages, events)` — the whole thread: split events into
 *     turns, pair each turn with its triggering user message, and interleave.
 *
 * Why event-sourced rendering: every RunnerEvent (text, tool-call,
 * tool-result, …) is persisted and replayed to the client. The persisted
 * assistant `message` row is just the concatenated text — it has no tool
 * calls. Rendering completed turns from their events is what lets tool-call
 * pills survive past `done` and across reloads, instead of vanishing the
 * moment the final answer lands.
 */
import type { MessageView, RunnerEvent } from "@cogni/contract";

// ─── Block model (one assistant turn) ────────────────────────────

export type Block =
  | { kind: "text"; text: string; streaming: boolean }
  | { kind: "tool"; toolId: string; name: string; input: unknown; result?: unknown; status: "running" | "done" | "error" }
  | { kind: "permission"; toolId: string; name: string; input: unknown }
  | { kind: "error"; code: string; message: string };

/**
 * Turn a flat RunnerEvent[] (one turn's worth) into a list of renderable
 * blocks.
 *
 *   - Consecutive `text` events concatenate into one running paragraph.
 *   - `tool-call` opens a tool block; the matching `tool-result` (by toolId)
 *     settles it to status "done".
 *   - `AskUserQuestion` tool-calls are hidden (the cloud bridges them into a
 *     separate needs-input UI; rendering the raw pill would be noise).
 *   - `permission-request` becomes its own block; `error` an inline block.
 *   - `session-id` / `done` are dropped (purely lifecycle).
 *
 * Every text block is marked `streaming: true`; the caller decides whether a
 * caret is actually drawn (only the in-flight turn streams).
 */
export function aggregateEvents(events: RunnerEvent[]): Block[] {
  const blocks: Block[] = [];
  const hiddenToolIds = new Set<string>();
  for (const e of events) {
    if (e.type === "text") {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "text") {
        last.text += e.text;
      } else {
        blocks.push({ kind: "text", text: e.text, streaming: true });
      }
    } else if (e.type === "tool-call") {
      if (e.name === "AskUserQuestion") {
        hiddenToolIds.add(e.toolId);
        continue;
      }
      blocks.push({ kind: "tool", toolId: e.toolId, name: e.name, input: e.input, status: "running" });
    } else if (e.type === "tool-result") {
      if (hiddenToolIds.has(e.toolId)) continue;
      const idx = findToolIdx(blocks, e.toolId);
      const target = idx >= 0 ? blocks[idx] : undefined;
      if (target && target.kind === "tool") {
        target.result = e.output;
        target.status = "done";
      } else {
        // Orphan result — render as its own block so we never silently drop data.
        blocks.push({ kind: "tool", toolId: e.toolId, name: "unknown", input: undefined, result: e.output, status: "done" });
      }
    } else if (e.type === "permission-request") {
      blocks.push({ kind: "permission", toolId: e.toolId, name: e.name, input: e.input });
    } else if (e.type === "error") {
      blocks.push({ kind: "error", code: e.code, message: e.message });
    }
  }
  return blocks;
}

function findToolIdx(blocks: Block[], toolId: string): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === "tool" && b.toolId === toolId) return i;
  }
  return -1;
}

// ─── Whole-thread timeline ───────────────────────────────────────

export type TimelineRow =
  | { kind: "user"; key: string; text: string }
  | { kind: "system"; key: string; text: string }
  | { kind: "assistant"; key: string; blocks: Block[]; streaming: boolean }
  | { kind: "assistant-text"; key: string; text: string };

export interface Timeline {
  rows: TimelineRow[];
  /** Last row is an unanswered user turn → caller shows a typing indicator. */
  awaitingReply: boolean;
}

/**
 * Split a thread's full event stream into per-turn segments. A turn ends at a
 * `done` / `error` event (its terminator is kept in the segment so callers can
 * tell completed turns from the in-flight tail).
 */
export function splitTurns(events: RunnerEvent[]): RunnerEvent[][] {
  const turns: RunnerEvent[][] = [];
  let cur: RunnerEvent[] = [];
  for (const e of events) {
    cur.push(e);
    if (e.type === "done" || e.type === "error") {
      turns.push(cur);
      cur = [];
    }
  }
  if (cur.length) turns.push(cur);
  return turns;
}

/**
 * Build the renderable timeline from persisted message rows + the thread's
 * event stream.
 *
 * Pairing is anchored on **user** messages: each user message triggers exactly
 * one runner turn, so the k-th user message owns the k-th turn. Assistant
 * message rows are skipped — their content (plus tool pills) comes from the
 * paired turn's events. The last turn renders with `streaming: true` while it
 * has no terminator yet (the live, in-flight reply).
 *
 * Fallback: if there are no events at all (e.g. the catchup-too-long path drops
 * back to an HTTP message-only fetch), every row is rendered straight from the
 * message table — assistant turns as plain text, no tool pills.
 */
export function buildTimeline(messages: MessageView[], events: RunnerEvent[]): Timeline {
  const turns = splitTurns(events);

  if (turns.length === 0) {
    const rows: TimelineRow[] = messages.map((m) =>
      m.role === "assistant"
        ? { kind: "assistant-text", key: m.id, text: m.content }
        : m.role === "system"
          ? { kind: "system", key: m.id, text: m.content }
          : { kind: "user", key: m.id, text: m.content },
    );
    return { rows, awaitingReply: lastIsUser(rows) };
  }

  const rows: TimelineRow[] = [];
  let ti = 0;
  for (const m of messages) {
    if (m.role === "assistant") continue; // rendered via the triggering user's turn
    if (m.role === "system") {
      rows.push({ kind: "system", key: m.id, text: m.content });
      continue;
    }
    // user turn
    rows.push({ kind: "user", key: m.id, text: m.content });
    const turn = turns[ti];
    if (turn) {
      const terminated = turn.some((e) => e.type === "done" || e.type === "error");
      const isLast = ti === turns.length - 1;
      const blocks = aggregateEvents(turn);
      if (blocks.length > 0) {
        rows.push({ kind: "assistant", key: `t-${m.id}`, blocks, streaming: isLast && !terminated });
      }
      ti++;
    }
  }
  return { rows, awaitingReply: lastIsUser(rows) };
}

function lastIsUser(rows: TimelineRow[]): boolean {
  const last = rows[rows.length - 1];
  return !!last && last.kind === "user";
}

/**
 * Whether the thread is waiting on the runner with **no visible progress** —
 * the states where a stall timer should be armed so an undelivered turn can't
 * spin the "• • •" indicator (or the streaming caret) forever.
 *
 * True when:
 *   - the last user turn has produced nothing yet (`awaitingReply`), or
 *   - the in-flight turn is streaming but has no tool *currently running*.
 *
 * A running tool pill is itself visible progress (a long `Bash`/build is
 * legitimately silent for a while), so we deliberately do NOT arm the timer
 * then — that would false-flag a slow-but-healthy command. The timer only
 * guards the cases where the user is staring at an indicator with zero signal.
 */
export function isAwaitingProgress(timeline: Timeline): boolean {
  if (timeline.awaitingReply) return true;
  const last = timeline.rows[timeline.rows.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return !last.blocks.some((b) => b.kind === "tool" && b.status === "running");
  }
  return false;
}

// ─── Tool-call argument preview ──────────────────────────────────

/**
 * Render a tool-call's input as a short, human one-liner instead of raw JSON.
 * Surfaces the single most meaningful argument per common tool (file path,
 * shell command, search pattern, …) and shortens the long
 * `~/.cogni/threads/<uuid>/` workspace prefix so a pill reads `cat.svg`, not
 * `{"file_path":"/Users/…/threads/8cdf…/cat.svg"}`.
 */
export function toolInputPreview(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const path = o.file_path ?? o.path ?? o.notebook_path;
  if (typeof path === "string") return shortenPath(path);
  if (typeof o.command === "string") return o.command;
  if (typeof o.pattern === "string") return o.pattern;
  if (typeof o.url === "string") return o.url;
  if (typeof o.query === "string") return o.query;
  if (typeof o.description === "string") return o.description;
  if (typeof o.prompt === "string") return o.prompt;
  return safeStringify(o);
}

function shortenPath(p: string): string {
  const m = p.match(/\.cogni\/threads\/[^/]+\/(.+)$/);
  return m && m[1] ? m[1] : p;
}

export function safeStringify(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…" : s;
}
