/**
 * ProjectBoard — supervised orchestration view for ONE project.
 *
 * (Renamed from "Project" in the SP-1 mock-driven layout; the file used to
 * live at apps/desktop/src/Project.tsx. Same kanban-columns / swarm / timeline
 * triple view; same breadcrumb / toolbar / drawer hand-off. Only the data
 * source changed: instead of `MOCK_TASKS.filter(...)`, the caller passes the
 * project row + its tasks coming from `useProjectBoard(api, projectId)`.)
 *
 * The drawer (`<TaskDetail>`) is mounted by the page-level Shell/App so that
 * single-source state (which task is open, which runner is streaming) lives
 * one layer up — not inside the board. `onOpenTask(id)` is fired here; the
 * Shell flips `activeTaskId` and renders the drawer.
 *
 * Visible behaviour vs. PR #11:
 *   - The colour palette, density and animations are identical (CSS unchanged)
 *   - State pill / progress bar values now come from the real `ProjectTask`
 *     row's `state` / `retries` / `startedAt`. Fields the SP-3 contract does
 *     not (yet) surface (progress %, "delta" line counts, free-text activity)
 *     fall back to reasonable defaults — the layout reserves space for them.
 *   - Hosts column / chip uses the live `HostInfo[]` the Shell already
 *     fetches via `useHosts`, not a mock.
 */
import { useMemo, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import type { TFunction } from "i18next";
import type { Project, ProjectTask, TaskState } from "@cogni/contract";
import type { HostInfo } from "../../transport/api.js";
import { Icon } from "../icons.js";
import { LoadingState } from "../LoadingState.js";
import "./project-board.css";

type View = "columns" | "swarm" | "timeline";

// SP-3 backend has no "failed" column distinct from `failed` task state in the
// contract, so the UI still shows it. The five columns mirror PR #11 exactly.
const COLUMN_STATES: TaskState[] = ["queued", "running", "needs-input", "reviewing", "done"];

export const STATE_COLOR: Record<TaskState, string> = {
  queued:        "var(--muted)",
  running:       "var(--accent)",
  "needs-input": "var(--warn)",
  reviewing:     "oklch(60% 0.10 270)",
  done:          "var(--good)",
  failed:        "var(--bad)",
  cancelled:     "var(--muted)",
};

/**
 * Static, NON-reactive state→label map. Kept exported (the package barrel
 * re-exports it) as a backwards-compatible fallback, but UI in this file no
 * longer reads it for display — it translates at render time via
 * `t(`project.state.${state}`)` so switching language updates instantly.
 * Do NOT use this for user-facing text in new code; call `t()` instead.
 */
export const STATE_LABEL: Record<TaskState, string> = {
  queued:        "排队中",
  running:       "进行中",
  "needs-input": "等待输入",
  reviewing:     "待 review",
  done:          "已完成",
  failed:        "失败",
  cancelled:     "已取消",
};

/** Translate a TaskState to its localized label at render time. */
export function stateLabel(t: TFunction, state: TaskState): string {
  return t(`project.state.${state}`);
}

export function ProjectBoard({
  project,
  tasks,
  loading = false,
  hosts = [],
  onBack,
  onNewTask,
  onOpenSettings,
  onOpenTask,
  onPrefetchTask,
  onMoveTask,
}: {
  project: Project | null;
  tasks: ProjectTask[];
  loading?: boolean;
  hosts?: HostInfo[];
  onBack?: () => void;
  onNewTask?: () => void;
  onOpenSettings?: () => void;
  onOpenTask?: (id: string) => void;
  /** Hover-prefetch a task's detail into the SWR cache (flash-free drawer). */
  onPrefetchTask?: (id: string) => void;
  /**
   * Kanban drag-to-column. Fired when a task card is dropped on a column whose
   * `TaskState` differs from the card's current state — the Shell wires this to
   * `api.moveTaskState`. Omit to disable the drop (cards still drag but nothing
   * happens on release).
   */
  onMoveTask?: (taskId: string, to: TaskState) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("columns");

  const live   = tasks.filter((t) => t.state === "running" || t.state === "needs-input").length;
  const queued = tasks.filter((t) => t.state === "queued").length;
  const needs  = tasks.filter((t) => t.state === "needs-input").length;

  const hostMap = useMemo(() => {
    const m = new Map<string, HostInfo>();
    for (const h of hosts) m.set(h.id, h);
    return m;
  }, [hosts]);

  if (!project && loading) {
    return <ProjectBoardLoading onBack={onBack} />;
  }

  return (
    <div className="project">
      <header className="project__head">
        <div className="project__head-text">
          <nav className="project__crumbs">
            <button className="project__crumb" onClick={onBack}>{t("project.board.crumbRoot")}</button>
            <span className="project__crumb-sep">/</span>
            <span className="project__crumb project__crumb--current">{project?.name ?? t("project.board.notFound")}</span>
          </nav>
          {project?.description && <div className="project__desc">{project.description}</div>}
          <div className="project__sub">
            <span className="dot" style={{ background: "var(--accent)" }} />
            <span>
              <Trans
                i18nKey="project.board.summary"
                values={{ live, queued }}
                components={[<b key="live" />, <b key="queued" />]}
              />
            </span>
            {needs > 0 && (
              <span className="project__needs-pill">
                <span className="project__needs-pill-dot" />
                <span>{t("project.board.needsPill", { n: needs })}</span>
              </span>
            )}
          </div>
        </div>
        <div className="project__head-tools">
          <div className="seg">
            <button className={"seg__btn" + (view === "columns" ? " is-on" : "")} onClick={() => setView("columns")}>Columns</button>
            <button className={"seg__btn" + (view === "swarm"   ? " is-on" : "")} onClick={() => setView("swarm")}>Swarm</button>
            <button className={"seg__btn" + (view === "timeline"? " is-on" : "")} onClick={() => setView("timeline")}>Timeline</button>
          </div>
          <button className="btn btn-sm" onClick={onNewTask}>{Icon.plus} {t("project.board.newTask")}</button>
          <button className="btn btn-sm btn-ghost" onClick={onOpenSettings} title={t("project.board.settings")}>{Icon.cog}</button>
        </div>
      </header>

      {/* Event-delegated hover prefetch: each task card/row carries a
          `data-task-id`, so one listener here warms the drawer cache without
          threading a callback through every view + card variant. */}
      <div
        className="project__body"
        onMouseOver={(e) => {
          if (!onPrefetchTask) return;
          const el = (e.target as HTMLElement).closest<HTMLElement>("[data-task-id]");
          const id = el?.dataset.taskId;
          if (id) onPrefetchTask(id);
        }}
      >
        {view === "columns"  && <ColumnsView  tasks={tasks} hostMap={hostMap} onOpenTask={onOpenTask} onMoveTask={onMoveTask} />}
        {view === "swarm"    && <SwarmView    tasks={tasks} hostMap={hostMap} onOpenTask={onOpenTask} />}
        {view === "timeline" && <TimelineView tasks={tasks} hostMap={hostMap} onOpenTask={onOpenTask} />}
      </div>
    </div>
  );
}

/* ─── Columns ──────────────────────────────────────────── */

function ProjectBoardLoading({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="project project--loading" aria-busy="true">
      <header className="project__head">
        <div className="project__head-text">
          <nav className="project__crumbs">
            <button className="project__crumb" onClick={onBack}>{t("project.board.crumbRoot")}</button>
            <span className="project__crumb-sep">/</span>
            <span className="project__crumb project__crumb--current">{t("project.board.syncing")}</span>
          </nav>
          <span className="project__title-skeleton loading-skeleton" />
          <div className="project__sub">
            <span className="dot dot-accent" />
            <span>{t("project.board.loadingTasks")}</span>
          </div>
        </div>
        <div className="project__head-tools">
          <span className="project__tool-skeleton loading-skeleton" />
          <span className="project__tool-skeleton project__tool-skeleton--short loading-skeleton" />
        </div>
      </header>
      <div className="project__body project__body--loading">
        <LoadingState variant="section" title={t("project.board.syncingBoardTitle")} subtitle={t("project.board.syncingBoardSubtitle")} />
        <div className="kb-cols kb-cols--loading">
          {COLUMN_STATES.map((state) => (
            <div key={state} className="kb-col">
              <div className="kb-col__head">
                <span className="dot" style={{ background: STATE_COLOR[state] }} />
                <span className="kb-col__label">{stateLabel(t, state)}</span>
              </div>
              <div className="kb-col__body">
                <TaskCardSkeleton />
                <TaskCardSkeleton compact />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TaskCardSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={"kb-card kb-card--skeleton" + (compact ? " kb-card--skeleton-compact" : "")}>
      <div className="kb-card__head">
        <span className="kb-card__ref-skeleton loading-skeleton" />
        <span className="kb-card__pill-skeleton loading-skeleton" />
      </div>
      <span className="kb-card__title-skeleton loading-skeleton" />
      {!compact && <span className="kb-card__activity-skeleton loading-skeleton" />}
      <div className="kb-progress kb-progress--skeleton loading-skeleton" />
      <div className="kb-card__foot">
        <span className="kb-card__host-skeleton loading-skeleton" />
        <span className="kb-card__time-skeleton loading-skeleton" />
      </div>
    </div>
  );
}

function ColumnsView({ tasks, hostMap, onOpenTask, onMoveTask }: { tasks: ProjectTask[]; hostMap: Map<string, HostInfo>; onOpenTask?: (id: string) => void; onMoveTask?: (taskId: string, to: TaskState) => void }) {
  const { t } = useTranslation();
  return (
    <div className="kb-cols">
      {COLUMN_STATES.map((state) => {
        const filtered = tasks.filter((t) => t.state === state);
        return (
          <div
            key={state}
            className={"kb-col" + (state === "needs-input" && filtered.length > 0 ? " kb-col--alert" : "")}
            onDragOver={onMoveTask ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } : undefined}
            onDragEnter={onMoveTask ? (e) => (e.currentTarget as HTMLElement).classList.add("kb-col--drop") : undefined}
            onDragLeave={onMoveTask ? (e) => {
              // Only clear when the pointer actually left the column (not when it
              // crossed onto a child element, which also fires dragleave).
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                (e.currentTarget as HTMLElement).classList.remove("kb-col--drop");
              }
            } : undefined}
            onDrop={onMoveTask ? (e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).classList.remove("kb-col--drop");
              const id = e.dataTransfer.getData("text/task-id");
              if (id) onMoveTask(id, state); // `state` is this column's TaskState
            } : undefined}
          >
            <div className="kb-col__head">
              <span className="dot" style={{ background: STATE_COLOR[state] }} />
              <span className="kb-col__label">{stateLabel(t, state)}</span>
              <span className="kb-col__count">{filtered.length}</span>
            </div>
            <div className="kb-col__body">
              {filtered.length === 0
                ? <div className="kb-col__empty">{t("project.board.columnEmpty")}</div>
                : filtered.map((t) => <ColumnCard key={t.id} task={t} hostMap={hostMap} onOpen={onOpenTask} draggable={!!onMoveTask} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ColumnCard({ task, hostMap, onOpen, draggable = false }: { task: ProjectTask; hostMap: Map<string, HostInfo>; onOpen?: (id: string) => void; draggable?: boolean }) {
  const { t } = useTranslation();
  const host = task.hostId ? hostMap.get(task.hostId) : undefined;
  const cls = "kb-card"
    + (task.state === "running"     ? " kb-card--running" : "")
    + (task.state === "needs-input" ? " kb-card--needs-input" : "")
    + (task.state === "failed"      ? " kb-card--failed" : "");
  const progress = inferProgress(task);
  const activity = inferActivity(t, task);
  const elapsed = inferElapsed(task);
  return (
    <button
      className={cls}
      data-task-id={task.id}
      onClick={() => onOpen?.(task.id)}
      draggable={draggable}
      onDragStart={draggable ? (e) => {
        e.dataTransfer.setData("text/task-id", task.id);
        e.dataTransfer.effectAllowed = "move";
      } : undefined}
    >
      <div className="kb-card__head">
        <span className="kb-card__ref">{task.ref}</span>
        <StatePill state={task.state} />
      </div>
      <div className="kb-card__title">{task.title}</div>
      {task.state !== "queued" && <div className="kb-card__activity">{activity}</div>}
      {(task.state === "running" || task.state === "reviewing" || task.state === "failed") && (
        <div className="kb-progress">
          <div className="kb-progress__fill" style={{ width: `${progress * 100}%`, background: STATE_COLOR[task.state] }} />
        </div>
      )}
      <div className="kb-card__foot">
        <div className="kb-card__meta">
          {host && (
            <>
              <span className={"dot " + (host.status === "online" ? "dot-online" : "dot-offline")} />
              <span className="kb-card__host">{shortHost(host.name)}</span>
            </>
          )}
          {task.retries > 0 && (
            <span className="kb-card__retry" title={t("project.board.retries", { n: task.retries })}>
              {Icon.refresh}{task.retries}
            </span>
          )}
        </div>
        <div className="kb-card__meta">
          {elapsed && <span className="kb-card__time">{elapsed}</span>}
        </div>
      </div>
    </button>
  );
}

/* ─── Swarm ────────────────────────────────────────────── */

function SwarmView({ tasks, hostMap, onOpenTask }: { tasks: ProjectTask[]; hostMap: Map<string, HostInfo>; onOpenTask?: (id: string) => void }) {
  const { t: tr } = useTranslation();
  const live   = tasks.filter((t) => t.state === "running" || t.state === "needs-input" || t.state === "reviewing" || t.state === "failed");
  const queued = tasks.filter((t) => t.state === "queued");
  const done   = tasks.filter((t) => t.state === "done");
  return (
    <div className="sw">
      <SwarmSection state="needs-input" title={tr("project.board.swarmNeedsInput")} count={live.filter((t) => t.state === "needs-input").length}>
        <div className="sw__grid">
          {live.filter((t) => t.state === "needs-input").map((t) => <Pod key={t.id} task={t} hostMap={hostMap} onOpen={onOpenTask} />)}
        </div>
      </SwarmSection>
      <SwarmSection state="running" title={tr("project.board.swarmRunning")} count={live.filter((t) => t.state !== "needs-input").length}>
        <div className="sw__grid">
          {live.filter((t) => t.state !== "needs-input").map((t) => <Pod key={t.id} task={t} hostMap={hostMap} onOpen={onOpenTask} />)}
        </div>
      </SwarmSection>
      <SwarmSection state="queued" title={tr("project.board.swarmQueued")} count={queued.length}>
        <div className="sw__list">
          {queued.map((t) => (
            <button key={t.id} className="sw__row" data-task-id={t.id} onClick={() => onOpenTask?.(t.id)}>
              <span className="kb-card__ref">{t.ref}</span>
              <span className="sw__row-title">{t.title}</span>
              <span className="sw__row-meta">{tr("project.board.swarmQueuedMeta")}</span>
            </button>
          ))}
        </div>
      </SwarmSection>
      {done.length > 0 && (
        <SwarmSection state="done" title={tr("project.board.swarmDone")} count={done.length}>
          <div className="sw__list">
            {done.map((t) => (
              <button key={t.id} className="sw__row sw__row--dim" data-task-id={t.id} onClick={() => onOpenTask?.(t.id)}>
                <span className="kb-card__ref">{t.ref}</span>
                <span className="sw__row-title">{t.title}</span>
                <span className="sw__row-meta">{inferElapsed(t) ?? "—"}</span>
              </button>
            ))}
          </div>
        </SwarmSection>
      )}
    </div>
  );
}

function SwarmSection({ state, title, count, children }: { state: TaskState; title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="sw__section">
      <div className="sw__section-head">
        <span className="dot" style={{ background: STATE_COLOR[state] }} />
        <span className="sw__section-title">{title}</span>
        <span className="sw__section-count">{count}</span>
      </div>
      {children}
    </section>
  );
}

function Pod({ task, hostMap, onOpen }: { task: ProjectTask; hostMap: Map<string, HostInfo>; onOpen?: (id: string) => void }) {
  const { t } = useTranslation();
  const host = task.hostId ? hostMap.get(task.hostId) : undefined;
  const cls = "pod"
    + (task.state === "running"     ? " pod--live" : "")
    + (task.state === "needs-input" ? " pod--needs-input" : "")
    + (task.state === "failed"      ? " pod--failed" : "");
  const progress = inferProgress(task);
  const elapsed = inferElapsed(task) ?? "—";
  const activity = inferActivity(t, task);
  return (
    <button className={cls} data-task-id={task.id} onClick={() => onOpen?.(task.id)}>
      <div className="pod__head">
        <div className="pod__host">
          <span className={"dot " + (host?.status === "online" ? "dot-online" : "dot-offline")} />
          <span className="kb-card__host">{shortHost(host?.name || t("project.board.hostUnassigned"))}</span>
        </div>
        <StatePill state={task.state} />
      </div>
      <div className="kb-card__ref">{task.ref}</div>
      <div className="pod__title">{task.title}</div>
      <div className="pod__activity">
        <span className="pod__pulse" style={{ background: STATE_COLOR[task.state] }} />
        <span className="pod__activity-text">{activity}</span>
      </div>
      <div className="pod__meters">
        <Meter label={t("project.board.meterProgress")}>
          <div className="kb-progress">
            <div className="kb-progress__fill" style={{ width: `${progress * 100}%`, background: STATE_COLOR[task.state] }} />
          </div>
        </Meter>
        <Meter label={t("project.board.meterElapsed")}><span className="pod__metric">{elapsed}</span></Meter>
        <Meter label={t("project.board.meterRetry")}><span className="pod__metric" style={{ color: task.retries > 0 ? "var(--warn)" : "var(--muted)" }}>{task.retries}</span></Meter>
        <Meter label={t("project.board.meterAttempt")}><span className="pod__metric">#{task.retries + 1}</span></Meter>
      </div>
    </button>
  );
}

function Meter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pod__meter">
      <div className="pod__meter-label">{label.toUpperCase()}</div>
      <div className="pod__meter-value">{children}</div>
    </div>
  );
}

/* ─── Timeline ────────────────────────────────────────── */

function TimelineView({ tasks, hostMap, onOpenTask }: { tasks: ProjectTask[]; hostMap: Map<string, HostInfo>; onOpenTask?: (id: string) => void }) {
  const { t: tr } = useTranslation();
  const live = tasks.filter((t) => t.state !== "queued");
  const NOW_PCT = 78;
  return (
    <div className="tl">
      <div className="tl__axis">
        {["-30m", "-20m", "-10m", "now", "+10m"].map((l, i) => (
          <span key={i} className="tl__tick">{l}</span>
        ))}
      </div>
      <div className="tl__body">
        <div className="tl__now" style={{ left: `${NOW_PCT}%` }}>
          <div className="tl__now-bar" />
          <div className="tl__now-flag">NOW</div>
        </div>
        {live.map((t) => {
          const host = t.hostId ? hostMap.get(t.hostId) : undefined;
          const progress = inferProgress(t);
          const startPct = Math.max(2, NOW_PCT - 65 * progress);
          const widthPct = NOW_PCT - startPct;
          const color = STATE_COLOR[t.state];
          const activity = inferActivity(tr, t);
          return (
            <button key={t.id} className="tl__row" data-task-id={t.id} onClick={() => onOpenTask?.(t.id)}>
              <div className="tl__row-label">
                <span className="kb-card__ref">{t.ref}</span>
                <span className="tl__row-title">{t.title}</span>
                <span className="kb-card__host">{shortHost(host?.name || "")}</span>
              </div>
              <div className="tl__track">
                <div className="tl__bar" style={{ left: `${startPct}%`, width: `${widthPct}%`, background: `linear-gradient(90deg, color-mix(in oklch, ${color}, transparent 65%), ${color})`, borderColor: `color-mix(in oklch, ${color}, transparent 50%)` }}>
                  <span className="tl__bar-label">{activity}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Atoms ────────────────────────────────────────────── */

export function StatePill({ state }: { state: TaskState }) {
  const { t } = useTranslation();
  const color = STATE_COLOR[state];
  const isPulse = state === "running" || state === "needs-input";
  return (
    <span className="state-pill" style={{ color, background: `color-mix(in oklch, ${color}, var(--bg) 86%)` }}>
      <span className={"state-pill__dot" + (isPulse ? " state-pill__dot--pulse" : "")} style={{ background: color }} />
      {stateLabel(t, state)}
    </span>
  );
}

function shortHost(name: string): string {
  return name.split(" ").slice(0, 2).join(" ");
}

// ─── Display-only derivations from the contract row ─────────────────────────
//
// SP-3 contract does not surface progress %, free-text activity, or diff
// stats on the wire — those are server-side concerns the UI hasn't needed
// before. The card slots still expect *something*; these helpers pick a
// sensible default so the layout doesn't collapse.

/** 0..1; running tasks animate at 0.5 as a placeholder while real progress isn't wired. */
function inferProgress(t: ProjectTask): number {
  if (t.state === "done")       return 1.0;
  if (t.state === "reviewing")  return 1.0;
  if (t.state === "failed")     return 0.5;
  if (t.state === "running")    return 0.5;
  return 0;
}

function inferActivity(t: TFunction, task: ProjectTask): string {
  if (task.state === "needs-input" && task.needsInputWhat) return task.needsInputWhat;
  if (task.state === "queued")    return t("project.board.activityWaitRunner");
  if (task.state === "reviewing") return t("project.board.activityReviewing");
  if (task.state === "failed")    return t("project.board.activityFailed");
  if (task.state === "done")      return t("project.board.activityDone");
  return t("project.board.activityRunning");
}

function inferElapsed(t: ProjectTask): string | null {
  if (!t.startedAt) return null;
  const start = Date.parse(t.startedAt);
  const end = t.completedAt ? Date.parse(t.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60)   return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainder = secs % 60;
  if (mins < 60)   return `${mins}m ${remainder}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
