/**
 * Project — supervised orchestration view for ONE project.
 *
 * Replaces the SP-1 reference Project.tsx. Changes vs reference:
 *   - Adds breadcrumb (`项目 / <name>`)
 *   - Cards in all 3 views are clickable → opens TaskDetail drawer (right side)
 *   - needs-input cards in columns/swarm view have a pulsing amber border
 *   - "新任务" button in the toolbar → opens NewTask modal (host provides handler)
 *   - "项目设置" cog in the toolbar → opens ProjectSettings (host provides handler)
 *   - "项目" → "项目列表" breadcrumb is a real button (host provides handler)
 */
import { useMemo, useState } from "react";
import { Icon } from "@cogni/ui";
import { MOCK_TASKS, MOCK_HOSTS, MOCK_PROJECTS, STATE_COLOR, STATE_LABEL, type DesignTask } from "./mock.js";
import { TaskDetail } from "./TaskDetail.js";
import "./project.css";

type View = "columns" | "swarm" | "timeline";

export function Project({
  projectId = "p-sp2",
  onBack,
  onNewTask,
  onOpenSettings,
}: {
  projectId?: string;
  onBack?: () => void;
  onNewTask?: () => void;
  onOpenSettings?: () => void;
}) {
  const [view, setView] = useState<View>("swarm");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const project = MOCK_PROJECTS.find((p) => p.id === projectId) ?? MOCK_PROJECTS[0];
  const tasks = useMemo(() => MOCK_TASKS.filter((t) => t.projectId === project.id), [project.id]);

  const live    = tasks.filter((t) => ["running", "needs-input"].includes(t.state)).length;
  const queued  = tasks.filter((t) => t.state === "queued").length;
  const needs   = tasks.filter((t) => t.state === "needs-input").length;

  const orderedTaskIds = tasks.map((t) => t.id);
  const openTask = tasks.find((t) => t.id === openTaskId) ?? null;

  return (
    <div className="project">
      <header className="project__head">
        <div className="project__head-text">
          <nav className="project__crumbs">
            <button className="project__crumb" onClick={onBack}>项目</button>
            <span className="project__crumb-sep">/</span>
            <span className="project__crumb project__crumb--current">{project.name}</span>
          </nav>
          {project.description && <div className="project__desc">{project.description}</div>}
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
        {view === "columns"  && <ColumnsView tasks={tasks} onOpenTask={setOpenTaskId} />}
        {view === "swarm"    && <SwarmView    tasks={tasks} onOpenTask={setOpenTaskId} />}
        {view === "timeline" && <TimelineView tasks={tasks} onOpenTask={setOpenTaskId} />}
      </div>

      {openTask && (
        <TaskDetail
          task={openTask}
          allTaskIds={orderedTaskIds}
          onClose={() => setOpenTaskId(null)}
          onNavigate={(id) => setOpenTaskId(id)}
        />
      )}
    </div>
  );
}

/* ─── Columns ──────────────────────────────────────────── */

function ColumnsView({ tasks, onOpenTask }: { tasks: DesignTask[]; onOpenTask: (id: string) => void }) {
  const cols: DesignTask["state"][] = ["queued", "running", "needs-input", "reviewing", "done"];
  return (
    <div className="kb-cols">
      {cols.map((state) => {
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
                : filtered.map((t) => <ColumnCard key={t.id} task={t} onOpen={onOpenTask} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ColumnCard({ task, onOpen }: { task: DesignTask; onOpen: (id: string) => void }) {
  const host = MOCK_HOSTS.find((h) => h.id === task.hostId);
  const cls = "kb-card"
    + (task.state === "running"     ? " kb-card--running" : "")
    + (task.state === "needs-input" ? " kb-card--needs-input" : "")
    + (task.state === "failed"      ? " kb-card--failed" : "");
  return (
    <button className={cls} onClick={() => onOpen(task.id)}>
      <div className="kb-card__head">
        <span className="kb-card__ref">{task.ref}</span>
        <StatePill state={task.state} />
      </div>
      <div className="kb-card__title">{task.title}</div>
      {task.state !== "queued" && <div className="kb-card__activity">{task.activity}</div>}
      {(task.state === "running" || task.state === "reviewing" || task.state === "failed") && (
        <div className="kb-progress">
          <div className="kb-progress__fill" style={{ width: `${task.progress * 100}%`, background: STATE_COLOR[task.state] }} />
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
          {task.elapsed !== "—" && <span className="kb-card__time">{task.elapsed}</span>}
          <Delta delta={task.delta} />
        </div>
      </div>
    </button>
  );
}

/* ─── Swarm ────────────────────────────────────────────── */

function SwarmView({ tasks, onOpenTask }: { tasks: DesignTask[]; onOpenTask: (id: string) => void }) {
  const live   = tasks.filter((t) => ["running", "needs-input", "reviewing", "failed"].includes(t.state));
  const queued = tasks.filter((t) => t.state === "queued");
  const done   = tasks.filter((t) => t.state === "done");
  return (
    <div className="sw">
      <SwarmSection state="needs-input" title="等你回应" count={live.filter((t) => t.state === "needs-input").length}>
        <div className="sw__grid">
          {live.filter((t) => t.state === "needs-input").map((t) => <Pod key={t.id} task={t} onOpen={onOpenTask} />)}
        </div>
      </SwarmSection>
      <SwarmSection state="running" title="进行中" count={live.filter((t) => t.state !== "needs-input").length}>
        <div className="sw__grid">
          {live.filter((t) => t.state !== "needs-input").map((t) => <Pod key={t.id} task={t} onOpen={onOpenTask} />)}
        </div>
      </SwarmSection>
      <SwarmSection state="queued" title="排队" count={queued.length}>
        <div className="sw__list">
          {queued.map((t) => (
            <button key={t.id} className="sw__row" onClick={() => onOpenTask(t.id)}>
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
              <button key={t.id} className="sw__row sw__row--dim" onClick={() => onOpenTask(t.id)}>
                <span className="kb-card__ref">{t.ref}</span>
                <span className="sw__row-title">{t.title}</span>
                <span className="sw__row-meta">{t.elapsed}</span>
              </button>
            ))}
          </div>
        </SwarmSection>
      )}
    </div>
  );
}

function SwarmSection({ state, title, count, children }: { state: DesignTask["state"]; title: string; count: number; children: React.ReactNode }) {
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

function Pod({ task, onOpen }: { task: DesignTask; onOpen: (id: string) => void }) {
  const host = MOCK_HOSTS.find((h) => h.id === task.hostId);
  const cls = "pod"
    + (task.state === "running"     ? " pod--live" : "")
    + (task.state === "needs-input" ? " pod--needs-input" : "")
    + (task.state === "failed"      ? " pod--failed" : "");
  return (
    <button className={cls} onClick={() => onOpen(task.id)}>
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
        <span className="pod__activity-text">{task.activity}</span>
      </div>
      <div className="pod__meters">
        <Meter label="进度">
          <div className="kb-progress">
            <div className="kb-progress__fill" style={{ width: `${task.progress * 100}%`, background: STATE_COLOR[task.state] }} />
          </div>
        </Meter>
        <Meter label="已用"><span className="pod__metric">{task.elapsed}</span></Meter>
        <Meter label="重试"><span className="pod__metric" style={{ color: task.retries > 0 ? "var(--warn)" : "var(--muted)" }}>{task.retries}</span></Meter>
        <Meter label="diff"><Delta delta={task.delta} /></Meter>
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

function TimelineView({ tasks, onOpenTask }: { tasks: DesignTask[]; onOpenTask: (id: string) => void }) {
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
          const host = MOCK_HOSTS.find((h) => h.id === t.hostId);
          const startPct = Math.max(2, NOW_PCT - 65 * t.progress);
          const widthPct = NOW_PCT - startPct;
          const color = STATE_COLOR[t.state];
          return (
            <button key={t.id} className="tl__row" onClick={() => onOpenTask(t.id)}>
              <div className="tl__row-label">
                <span className="kb-card__ref">{t.ref}</span>
                <span className="tl__row-title">{t.title}</span>
                <span className="kb-card__host">{shortHost(host?.name || "")}</span>
              </div>
              <div className="tl__track">
                <div className="tl__bar" style={{ left: `${startPct}%`, width: `${widthPct}%`, background: `linear-gradient(90deg, color-mix(in oklch, ${color}, transparent 65%), ${color})`, borderColor: `color-mix(in oklch, ${color}, transparent 50%)` }}>
                  <span className="tl__bar-label">{t.activity}</span>
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

export function StatePill({ state }: { state: DesignTask["state"] }) {
  const color = STATE_COLOR[state];
  const isPulse = state === "running" || state === "needs-input";
  return (
    <span className="state-pill" style={{ color, background: `color-mix(in oklch, ${color}, var(--bg) 86%)` }}>
      <span className={"state-pill__dot" + (isPulse ? " state-pill__dot--pulse" : "")} style={{ background: color }} />
      {STATE_LABEL[state]}
    </span>
  );
}

export function Delta({ delta }: { delta: string }) {
  if (delta === "—") return <span className="pod__metric pod__metric--muted">—</span>;
  const [plus, minus] = delta.split(" ");
  return (
    <span className="pod__metric">
      <span style={{ color: "var(--good)" }}>{plus}</span>{" "}
      <span style={{ color: "var(--bad)" }}>{minus}</span>
    </span>
  );
}

function shortHost(name: string): string {
  return name.split(" ").slice(0, 2).join(" ");
}
