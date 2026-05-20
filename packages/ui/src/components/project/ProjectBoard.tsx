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

export const STATE_LABEL: Record<TaskState, string> = {
  queued:        "排队中",
  running:       "进行中",
  "needs-input": "等待输入",
  reviewing:     "待 review",
  done:          "已完成",
  failed:        "失败",
  cancelled:     "已取消",
};

export function ProjectBoard({
  project,
  tasks,
  loading = false,
  hosts = [],
  onBack,
  onNewTask,
  onOpenSettings,
  onOpenTask,
}: {
  project: Project | null;
  tasks: ProjectTask[];
  loading?: boolean;
  hosts?: HostInfo[];
  onBack?: () => void;
  onNewTask?: () => void;
  onOpenSettings?: () => void;
  onOpenTask?: (id: string) => void;
}) {
  const [view, setView] = useState<View>("swarm");

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
            <button className="project__crumb" onClick={onBack}>项目</button>
            <span className="project__crumb-sep">/</span>
            <span className="project__crumb project__crumb--current">{project?.name ?? "项目未找到"}</span>
          </nav>
          {project?.description && <div className="project__desc">{project.description}</div>}
          <div className="project__sub">
            <span className="dot" style={{ background: "var(--accent)" }} />
            <span><b>{live}</b> 在跑 · <b>{queued}</b> 排队</span>
            {needs > 0 && (
              <span className="project__needs-pill">
                <span className="project__needs-pill-dot" />
                <span>{needs} 个等你</span>
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
          <button className="btn btn-sm" onClick={onNewTask}>{Icon.plus} 新任务</button>
          <button className="btn btn-sm btn-ghost" onClick={onOpenSettings} title="项目设置">{Icon.cog}</button>
        </div>
      </header>

      <div className="project__body">
        {view === "columns"  && <ColumnsView  tasks={tasks} hostMap={hostMap} onOpenTask={onOpenTask} />}
        {view === "swarm"    && <SwarmView    tasks={tasks} hostMap={hostMap} onOpenTask={onOpenTask} />}
        {view === "timeline" && <TimelineView tasks={tasks} hostMap={hostMap} onOpenTask={onOpenTask} />}
      </div>
    </div>
  );
}

/* ─── Columns ──────────────────────────────────────────── */

function ProjectBoardLoading({ onBack }: { onBack?: () => void }) {
  return (
    <div className="project project--loading" aria-busy="true">
      <header className="project__head">
        <div className="project__head-text">
          <nav className="project__crumbs">
            <button className="project__crumb" onClick={onBack}>项目</button>
            <span className="project__crumb-sep">/</span>
            <span className="project__crumb project__crumb--current">同步中</span>
          </nav>
          <span className="project__title-skeleton loading-skeleton" />
          <div className="project__sub">
            <span className="dot dot-accent" />
            <span>正在装载任务面板</span>
          </div>
        </div>
        <div className="project__head-tools">
          <span className="project__tool-skeleton loading-skeleton" />
          <span className="project__tool-skeleton project__tool-skeleton--short loading-skeleton" />
        </div>
      </header>
      <div className="project__body project__body--loading">
        <LoadingState variant="section" title="正在同步项目面板" subtitle="加载任务队列、Runner 状态和时间线" />
        <div className="kb-cols kb-cols--loading">
          {COLUMN_STATES.map((state) => (
            <div key={state} className="kb-col">
              <div className="kb-col__head">
                <span className="dot" style={{ background: STATE_COLOR[state] }} />
                <span className="kb-col__label">{STATE_LABEL[state]}</span>
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

function ColumnsView({ tasks, hostMap, onOpenTask }: { tasks: ProjectTask[]; hostMap: Map<string, HostInfo>; onOpenTask?: (id: string) => void }) {
  return (
    <div className="kb-cols">
      {COLUMN_STATES.map((state) => {
        const filtered = tasks.filter((t) => t.state === state);
        return (
          <div key={state} className={"kb-col" + (state === "needs-input" && filtered.length > 0 ? " kb-col--alert" : "")}>
            <div className="kb-col__head">
              <span className="dot" style={{ background: STATE_COLOR[state] }} />
              <span className="kb-col__label">{STATE_LABEL[state]}</span>
              <span className="kb-col__count">{filtered.length}</span>
            </div>
            <div className="kb-col__body">
              {filtered.length === 0
                ? <div className="kb-col__empty">空</div>
                : filtered.map((t) => <ColumnCard key={t.id} task={t} hostMap={hostMap} onOpen={onOpenTask} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ColumnCard({ task, hostMap, onOpen }: { task: ProjectTask; hostMap: Map<string, HostInfo>; onOpen?: (id: string) => void }) {
  const host = task.hostId ? hostMap.get(task.hostId) : undefined;
  const cls = "kb-card"
    + (task.state === "running"     ? " kb-card--running" : "")
    + (task.state === "needs-input" ? " kb-card--needs-input" : "")
    + (task.state === "failed"      ? " kb-card--failed" : "");
  const progress = inferProgress(task);
  const activity = inferActivity(task);
  const elapsed = inferElapsed(task);
  return (
    <button className={cls} onClick={() => onOpen?.(task.id)}>
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
            <span className="kb-card__retry" title={`${task.retries} retries`}>
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
  const live   = tasks.filter((t) => t.state === "running" || t.state === "needs-input" || t.state === "reviewing" || t.state === "failed");
  const queued = tasks.filter((t) => t.state === "queued");
  const done   = tasks.filter((t) => t.state === "done");
  return (
    <div className="sw">
      <SwarmSection state="needs-input" title="等你回应" count={live.filter((t) => t.state === "needs-input").length}>
        <div className="sw__grid">
          {live.filter((t) => t.state === "needs-input").map((t) => <Pod key={t.id} task={t} hostMap={hostMap} onOpen={onOpenTask} />)}
        </div>
      </SwarmSection>
      <SwarmSection state="running" title="进行中" count={live.filter((t) => t.state !== "needs-input").length}>
        <div className="sw__grid">
          {live.filter((t) => t.state !== "needs-input").map((t) => <Pod key={t.id} task={t} hostMap={hostMap} onOpen={onOpenTask} />)}
        </div>
      </SwarmSection>
      <SwarmSection state="queued" title="排队" count={queued.length}>
        <div className="sw__list">
          {queued.map((t) => (
            <button key={t.id} className="sw__row" onClick={() => onOpenTask?.(t.id)}>
              <span className="kb-card__ref">{t.ref}</span>
              <span className="sw__row-title">{t.title}</span>
              <span className="sw__row-meta">等可用 runner</span>
            </button>
          ))}
        </div>
      </SwarmSection>
      {done.length > 0 && (
        <SwarmSection state="done" title="今日完成" count={done.length}>
          <div className="sw__list">
            {done.map((t) => (
              <button key={t.id} className="sw__row sw__row--dim" onClick={() => onOpenTask?.(t.id)}>
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
  const host = task.hostId ? hostMap.get(task.hostId) : undefined;
  const cls = "pod"
    + (task.state === "running"     ? " pod--live" : "")
    + (task.state === "needs-input" ? " pod--needs-input" : "")
    + (task.state === "failed"      ? " pod--failed" : "");
  const progress = inferProgress(task);
  const elapsed = inferElapsed(task) ?? "—";
  const activity = inferActivity(task);
  return (
    <button className={cls} onClick={() => onOpen?.(task.id)}>
      <div className="pod__head">
        <div className="pod__host">
          <span className={"dot " + (host?.status === "online" ? "dot-online" : "dot-offline")} />
          <span className="kb-card__host">{shortHost(host?.name || "unassigned")}</span>
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
        <Meter label="进度">
          <div className="kb-progress">
            <div className="kb-progress__fill" style={{ width: `${progress * 100}%`, background: STATE_COLOR[task.state] }} />
          </div>
        </Meter>
        <Meter label="已用"><span className="pod__metric">{elapsed}</span></Meter>
        <Meter label="重试"><span className="pod__metric" style={{ color: task.retries > 0 ? "var(--warn)" : "var(--muted)" }}>{task.retries}</span></Meter>
        <Meter label="尝试"><span className="pod__metric">#{task.retries + 1}</span></Meter>
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
          const activity = inferActivity(t);
          return (
            <button key={t.id} className="tl__row" onClick={() => onOpenTask?.(t.id)}>
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
  const color = STATE_COLOR[state];
  const isPulse = state === "running" || state === "needs-input";
  return (
    <span className="state-pill" style={{ color, background: `color-mix(in oklch, ${color}, var(--bg) 86%)` }}>
      <span className={"state-pill__dot" + (isPulse ? " state-pill__dot--pulse" : "")} style={{ background: color }} />
      {STATE_LABEL[state]}
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

function inferActivity(t: ProjectTask): string {
  if (t.state === "needs-input" && t.needsInputWhat) return t.needsInputWhat;
  if (t.state === "queued")    return "等可用 runner";
  if (t.state === "reviewing") return "等你 review";
  if (t.state === "failed")    return "失败";
  if (t.state === "done")      return "已完成";
  return "运行中";
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
