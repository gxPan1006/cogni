/**
 * ChatBubble — a draggable pill FAB on the project / kanban page that expands
 * into a compact orchestrator chat popover.
 *
 * Direct experience:
 *   - Closed: a dark pill ("💬 Cogni 编排" + a grip) sitting bottom-centre by
 *     default. Drag it anywhere — it remembers where you dropped it across
 *     reloads. A pulsing accent dot hints when there's something unread.
 *   - Click (not drag) → a rounded popover rises above the pill. It opens on the
 *     session LIST: "开始新的编排对话" + every past session for this scope.
 *   - Pick a session → conversation view (transcript + composer + back arrow).
 *     The back arrow / ⌘N / × controls switch, create, and close.
 *
 * Behaviour: sessions are the scope's orchestrator threads — the AI in here can
 * directly create / cancel / delete / accept task cards and projects, exactly
 * like the bottom bar it replaces. Workspace scope lists cross-project sessions;
 * inside a board it lists that project's. Drafts are kept per-session so
 * switching never loses typed text; transcripts are server-persisted so they
 * never get lost either.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ThreadSummary } from "@cogni/contract";
import type { ApiClient } from "../../../transport/api.js";
import { Icon } from "../../icons.js";
import type { WorkspaceChatScope } from "../WorkspaceChatBar.js";
import { scopePlaceholder } from "../WorkspaceChatBar.js";
import { ChatPanel } from "./ChatPanel.js";
import {
  type Pos,
  POS_KEY,
  DEFAULT_BOTTOM,
  DRAG_THRESHOLD,
  clampCenter,
  computePanelRect,
} from "./geometry.js";
import "./chat-bubble.css";

function errText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return String(e ?? "未知错误");
}

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Pos>;
    if (typeof v?.x === "number" && typeof v?.y === "number") return { x: v.x, y: v.y };
  } catch {
    /* ignore malformed storage */
  }
  return null;
}

export function ChatBubble({ api, scope }: { api: ApiClient; scope: WorkspaceChatScope }) {
  const projectId = scope.kind === "project" ? scope.projectId : undefined;
  const scopeLabel = scope.kind === "project" ? scope.projectName : "工作区编排";
  const composerPlaceholder = scopePlaceholder(scope);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(loadPos);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);

  const [sessions, setSessions] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);

  // Scope flip (workspace ↔ project, or switching projects) resets the view.
  useEffect(() => {
    setActiveId(null);
    setSessions([]);
  }, [projectId]);

  // Load the scope's sessions whenever the popover opens (cheap; keeps the list
  // fresh after the orchestrator created/renamed something elsewhere).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    api
      .listOrchestratorThreads(projectId)
      .then((rows) => {
        if (live) setSessions(rows);
      })
      .catch((e) => {
        if (live) setError("加载会话失败:" + errText(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, open, projectId]);

  const onNew = useCallback(() => {
    setCreating(true);
    setError(null);
    api
      .createOrchestratorThread(projectId)
      .then((created) => {
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        setActiveId(created.id);
      })
      .catch((e) => {
        // Never fail silently — a swallowed error here looked like "点击没反应".
        setError("新建会话失败:" + errText(e));
      })
      .finally(() => setCreating(false));
  }, [api, projectId]);

  const onTitled = useCallback((id: string, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  }, []);

  const setDraft = useCallback(
    (v: string) => {
      if (activeId) setDrafts((prev) => ({ ...prev, [activeId]: v }));
    },
    [activeId],
  );

  // ── Drag ──────────────────────────────────────────────────────────────
  const onBubbleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - (rect.left + rect.width / 2),
      offsetY: e.clientY - (rect.top + rect.height / 2),
      moved: false,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      if (!dragging) setDragging(true);
      setPos(clampCenter({ x: e.clientX - d.offsetX, y: e.clientY - d.offsetY }, window.innerWidth, window.innerHeight));
    };
    const onUp = () => {
      const moved = dragRef.current?.moved;
      dragRef.current = null;
      setDragging(false);
      if (moved) {
        setPos((p) => {
          if (p) {
            try {
              localStorage.setItem(POS_KEY, JSON.stringify(p));
            } catch {
              /* ignore */
            }
          }
          return p;
        });
        // Swallow the click that fires right after a drag so we don't toggle open.
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
          window.removeEventListener("click", swallow, true);
        };
        window.addEventListener("click", swallow, true);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // Keep the bubble inside the viewport across window resizes.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => (p ? clampCenter(p, window.innerWidth, window.innerHeight) : null));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keyboard: Esc closes, ⌘N / Ctrl+N opens a new session — only while open.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        onNew();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onNew]);

  // ── Layout ────────────────────────────────────────────────────────────
  const bubbleStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto", transform: "translate(-50%, -50%)" }
    : { left: "50%", bottom: DEFAULT_BOTTOM, right: "auto", top: "auto", transform: "translateX(-50%)" };

  const panelStyle: React.CSSProperties = (() => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    return computePanelRect(pos, vw, vh);
  })();

  return (
    <>
      {open && (
        <div className="cb-panel-wrap" style={panelStyle}>
          <ChatPanel
            api={api}
            sessions={sessions}
            active={active}
            scopeLabel={scopeLabel}
            composerPlaceholder={composerPlaceholder}
            loading={loading}
            creating={creating}
            error={error}
            draft={activeId ? drafts[activeId] ?? "" : ""}
            setDraft={setDraft}
            onPick={setActiveId}
            onNew={onNew}
            onBack={() => setActiveId(null)}
            onClose={() => setOpen(false)}
            onTitled={onTitled}
          />
        </div>
      )}
      <div className="cb-bubble-wrap" style={bubbleStyle}>
        <button
          className={"cb-bubble" + (open ? " is-open" : "") + (dragging ? " is-dragging" : "")}
          onMouseDown={onBubbleMouseDown}
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "收起 Cogni 编排" : "打开 Cogni 编排"}
          type="button"
        >
          <span className="cb-bubble-icon">{open ? Icon.x : Icon.chat}</span>
          {!open && <span className="cb-bubble-label">Cogni 编排</span>}
          {!open && (
            <span className="cb-bubble-grip" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </span>
          )}
        </button>
      </div>
    </>
  );
}
