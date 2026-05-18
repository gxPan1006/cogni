/**
 * ChatBlocks — all the building blocks for the conversation surface.
 *
 *   - <UserMessage>      a user's turn (a soft sand chip with markdown body)
 *   - <AssistantText>    the assistant's prose; supports markdown + streaming caret
 *   - <ToolCallBlock>    one tool invocation; collapsible to show input + result
 *   - <PermissionPrompt> SP-3 permission-request UI
 *   - <ThinkingBlock>    reserved — runner adapters don't emit thinking events yet
 *   - <SessionSwitch>    inline divider when a thread migrates to a new host
 *   - <FallbackCard>     "preferred host is offline" inline prompt
 *   - <NoHostBanner>     "no host is online at all" hard banner
 *
 * Plus one helper:
 *
 *   - aggregateEvents(events): turns a flat RunnerEvent[] (from useThreadStream)
 *     into a list of renderable Block objects — pairing tool-call/tool-result by
 *     toolId, concatenating consecutive text deltas, and dropping no-ops.
 *
 * All blocks share the same left-edge column. There is no left rail or avatar
 * column — alignment is preserved by giving every block the same outer padding.
 */
import { useState, type ReactNode } from "react";
import type { RunnerEvent } from "@cogni/contract";
import { Markdown } from "./Markdown.js";
import { Icon } from "./icons.js";
import "./chat-blocks.css";

// ─── Block components ────────────────────────────────────────────

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="msg msg--user">
      <div className="msg__user-card">
        <Markdown text={text} />
      </div>
    </div>
  );
}

export function AssistantText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="msg msg--assistant">
      <div className="msg__assistant-body">
        <Markdown text={text} />
        {streaming && <span className="msg__caret" aria-hidden="true" />}
      </div>
    </div>
  );
}

export function ThinkingBlock({ text, collapsed = false }: { text: string; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div className="msg msg--aux">
      <button className={"thinking" + (open ? " thinking--open" : "")} onClick={() => setOpen(!open)} type="button">
        <span className="thinking__icon">{Icon.brain}</span>
        <span className="thinking__label">思考中</span>
        <span className="thinking__toggle">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="thinking__body">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

export function ToolCallBlock({
  name,
  input,
  result,
  status = "done",
  defaultOpen = false,
}: {
  name: string;
  input: unknown;
  result?: unknown;
  status?: "running" | "done" | "error";
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const inputPreview = typeof input === "string" ? input : safeStringify(input);
  const resultText = typeof result === "string" ? result : safeStringify(result);

  return (
    <div className="msg msg--aux">
      <button
        className={"toolcall toolcall--" + status + (open ? " toolcall--open" : "")}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="toolcall__status">
          {status === "running" ? <span className="toolcall__spin">{Icon.refresh}</span> : Icon.tool}
        </span>
        <span className="toolcall__name">{name}</span>
        <span className="toolcall__input">{inputPreview}</span>
        <span className="toolcall__toggle">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="toolcall__body">
          {result === undefined ? (
            <div className="toolcall__result toolcall__result--empty">…</div>
          ) : (
            <pre className="toolcall__result">
              <code>{truncate(resultText, 4096)}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function PermissionPrompt({
  toolName,
  what,
  onAllow,
  onAllowAlways,
  onDeny,
}: {
  toolName: string;
  what: ReactNode;
  onAllow: () => void;
  onAllowAlways?: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="msg msg--aux">
      <div className="perm">
        <div className="perm__head">
          <span className="perm__icon">{Icon.shield}</span>
          <div>
            <div className="perm__title">需要授权</div>
            <div className="perm__sub">
              <code>{toolName}</code> 想要 {what}
            </div>
          </div>
        </div>
        <div className="perm__actions">
          <button className="btn btn-sm" onClick={onDeny} type="button">拒绝</button>
          <button className="btn btn-sm btn-primary" onClick={onAllow} type="button">允许一次</button>
          {onAllowAlways && (
            <button className="btn btn-sm btn-ghost" onClick={onAllowAlways} type="button">
              在此对话中总是允许
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SessionSwitch({ from, to }: { from: string; to: string }) {
  return (
    <div className="session-switch">
      <div className="session-switch__line" />
      <span className="session-switch__text">{from} → {to}</span>
      <div className="session-switch__line" />
    </div>
  );
}

export function FallbackCard({
  offlineHost,
  offlineSince,
  alternatives,
  onSwitch,
  onCancel,
}: {
  offlineHost: string;
  offlineSince: string;
  alternatives: { id: string; name: string; lastSeen: string }[];
  onSwitch: (hostId: string) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState(alternatives[0]?.id ?? "");
  return (
    <div className="msg msg--aux">
      <div className="fallback">
        <div className="fallback__head">
          <span className="fallback__icon">{Icon.bolt}</span>
          <div className="fallback__head-text">
            <div className="fallback__title">{offlineHost} 不在线</div>
            <div className="fallback__sub">{offlineSince}</div>
          </div>
        </div>
        <div className="fallback__body">切换到另一台机器跑?</div>
        <div className="fallback__options">
          {alternatives.map((alt) => (
            <label key={alt.id} className={"fallback__opt" + (picked === alt.id ? " fallback__opt--on" : "")}>
              <input type="radio" name="host" checked={picked === alt.id} onChange={() => setPicked(alt.id)} />
              <span className="dot dot-online" />
              <span className="fallback__opt-name">{alt.name}</span>
              <span className="fallback__opt-sub">· {alt.lastSeen}</span>
            </label>
          ))}
        </div>
        <div className="fallback__note">
          Claude Code 会基于消息历史在新机器上重建上下文。{offlineHost} 上未保存的文件不会过来。
        </div>
        <div className="fallback__actions">
          <button className="btn btn-sm" onClick={onCancel} type="button">等 {offlineHost} 上线</button>
          <button className="btn btn-sm btn-primary" onClick={() => onSwitch(picked)} type="button">切换并发送</button>
        </div>
      </div>
    </div>
  );
}

export function NoHostBanner({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <div className="no-host">
      <span className="no-host__icon">{Icon.bolt}</span>
      <div className="no-host__body">
        <div className="no-host__title">没有在线的 Cogni 桌面端</div>
        <div className="no-host__sub">至少打开一台 Mac 上的 Cogni 才能发消息。</div>
      </div>
      {onOpenSettings && <button className="btn btn-sm" onClick={onOpenSettings} type="button">管理 hosts</button>}
    </div>
  );
}

// ─── Stream aggregator ───────────────────────────────────────────

export type Block =
  | { kind: "text"; text: string; streaming: boolean }
  | { kind: "tool"; toolId: string; name: string; input: unknown; result?: unknown; status: "running" | "done" | "error" }
  | { kind: "permission"; toolId: string; name: string; input: unknown }
  | { kind: "error"; code: string; message: string };

/**
 * Turn a flat RunnerEvent[] stream into a list of renderable blocks.
 *
 *   - Consecutive `text` events are concatenated into one running paragraph.
 *   - `tool-call` opens a tool block (status: running).
 *   - The matching `tool-result` (by toolId) settles it (status: done).
 *   - `permission-request` becomes its own block; the parent caller decides
 *     how to respond (e.g. show a PermissionPrompt and POST /permissions).
 *   - `error` becomes an inline error block.
 *   - `session-id` / `done` are dropped (purely lifecycle).
 *
 * The last text block has `streaming: true` until `done` arrives; the parent
 * caller is expected to know whether the stream is still live and pass that
 * state through to the rendered `<AssistantText streaming>` prop. To make
 * this clean we mark *every* text block as streaming and let the caller
 * decide; if you want the final settled view, the cloud broadcasts the
 * persisted assistant message *before* `done`, so consumers can just stop
 * rendering the streaming aggregate and switch to the message row.
 */
export function aggregateEvents(events: RunnerEvent[]): Block[] {
  const blocks: Block[] = [];
  for (const e of events) {
    if (e.type === "text") {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "text") {
        last.text += e.text;
      } else {
        blocks.push({ kind: "text", text: e.text, streaming: true });
      }
    } else if (e.type === "tool-call") {
      blocks.push({ kind: "tool", toolId: e.toolId, name: e.name, input: e.input, status: "running" });
    } else if (e.type === "tool-result") {
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

// ─── Internal helpers ────────────────────────────────────────────

function safeStringify(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  try { return JSON.stringify(v); } catch { return String(v); }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…" : s;
}
