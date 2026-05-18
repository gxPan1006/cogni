/**
 * Project — supervised orchestration view (SP-3 reference design).
 *
 * STATUS: presentational reference only. Uses MOCK_TASKS. Three view modes:
 *   - columns:  classic kanban; each card is one live runner with progress/retries
 *   - swarm:    big "in-flight" cards showing each running agent in detail
 *   - timeline: lifespans per runner along a horizontal time axis
 *
 * When SP-3 lands, swap MOCK_TASKS for a `useProjectTasks(projectId)` hook that
 * subscribes to task events from the cloud (same `events` table as chat).
 */
import { useState } from "react";
import { Icon } from "./icons.js";
import { MOCK_TASKS, MOCK_HOSTS, STATE_COLOR, STATE_LABEL, type DesignTask } from "./mock.js";
import "./project.css";

type View = "columns" | "swarm" | "timeline";

export function Project({ projectName = "SP-2 · Sync & Web" }: { projectName?: string }) {
  const [view, setView] = useState<View>("swarm");
  const live = MOCK_TASKS.filter((t) => t.state === "running" || t.state === "needs-input").length;

  return (
    <div className="project">
      <header className="project__head">
        <div className="project__head-text">
          <div className="project__eyebrow">PROJECT</div>
          <h1 className="project__title">{projectName}</h1>
          <div className="project__sub">
            <span className="dot" style={{ background: "var(--accent)" }} />
            {live} runners alive · {MOCK_TASKS.filter((t) => t.state === "queued").length} queued
          </div>
        </div>
        <div className="project__head-tools">
          <div className="seg">
            <button className={"seg__btn" + (view === "columns" ? " is-on" : "")} onClick={() => setView("columns")}>Columns</button>
            <button className={"seg__btn" + (view === "swarm"   ? " is-on" : "")} onClick={() => setView("swarm")}>Swarm</button>
            <button className={"seg__btn" + (view === "timeline"? " is-on" : "")} onClick={() => setView("timeline")}>Timeline</button>
          </div>
          <button className="btn btn-sm">{Icon.plus} 新任务</button>
        </div>
      </header>

      <div className="project__body">
        {view === "columns"  && <ColumnsView />}
        {view === "swarm"    && <SwarmView />}
        {view === "timeline" && <TimelineView />}
      </div>
    </div>
  );
}

/* ─── Columns ──────────────────────────────────────────── */

function ColumnsView() {
  const cols: DesignTask["state"][] = ["queued", "running", "needs-input", "reviewing", "done"];
  return (
    <div className="kb-cols">
      {cols.map((state) => {
        const tasks = MOCK_TASKS.filter((t) => t.state === state);
        return (
          <div key={state} className="kb-col">
            <div className="kb-col__head">
              <span className="dot" style={{ background: STATE_COLOR[state] }} />
              <span className="kb-col__label">{STATE_LABEL[state]}</span>
              <span className="kb-col__count">{tasks.length}</span>
            </div>
            <div className="kb-col__body">
              {tasks.length === 0
                ? <div className="kb-col__empty">nothing here</div>
                : tasks.map((t) => <ColumnCard key={t.id} task={t} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ColumnCard({ task }: { task: DesignTask }) {
  const host = MOCK_HOSTS.find((h) => h.id === task.hostId);
  const isRunning = task.state === "running";
  return (
    <div className={"kb-card" + (isRunning ? " kb-card--running" : "")}>
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
    </div>
  );
}

/* ─── Swarm ────────────────────────────────────────────── */

function SwarmView() {
  const live   = MOCK_TASKS.filter((t) => ["running", "needs-input", "reviewing", "failed"].includes(t.state));
  const queued = MOCK_TASKS.filter((t) => t.state === "queued");
  const done   = MOCK_TASKS.filter((t) => t.state === "done");
  return (
    <div className="sw">
      <SwarmSection state="running" title="In flight" count={live.length}>
        <div className="sw__grid">
          {live.map((t) => <Pod key={t.id} task={t} />)}
        </div>
      </SwarmSection>
      <SwarmSection state="queued" title="Queued" count={queued.length}>
        <div className="sw__list">
          {queued.map((t) => (
            <div key={t.id} className="sw__row">
              <span className="kb-card__ref">{t.ref}</span>
              <span className="sw__row-title">{t.title}</span>
              <span className="sw__row-meta">waiting for runner</span>
            </div>
          ))}
        </div>
      </SwarmSection>
      <SwarmSection state="done" title="Done · today" count={done.length}>
        <div className="sw__list">
          {done.map((t) => (
            <div key={t.id} className="sw__row sw__row--dim">
              <span className="kb-card__ref">{t.ref}</span>
              <span className="sw__row-title">{t.title}</span>
              <span className="sw__row-meta">{t.elapsed}</span>
            </div>
          ))}
        </div>
      </SwarmSection>
    </div>
  );
}

function SwarmSection({ state, title, count, children }: { state: DesignTask["state"]; title: string; count: number; children: React.ReactNode }) {
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

function Pod({ task }: { task: DesignTask }) {
  const host = MOCK_HOSTS.find((h) => h.id === task.hostId);
  const live = task.state === "running";
  return (
    <div className={"pod" + (live ? " pod--live" : "")}>
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
        <Meter label="Progress">
          <div className="kb-progress">
            <div className="kb-progress__fill" style={{ width: `${task.progress * 100}%`, background: STATE_COLOR[task.state] }} />
          </div>
        </Meter>
        <Meter label="Elapsed"><span className="pod__metric">{task.elapsed}</span></Meter>
        <Meter label="Retries"><span className="pod__metric" style={{ color: task.retries > 0 ? "var(--warn)" : "var(--muted)" }}>{task.retries}</span></Meter>
        <Meter label="Delta"><Delta delta={task.delta} /></Meter>
      </div>
    </div>
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

function TimelineView() {
  const live = MOCK_TASKS.filter((t) => t.state !== "queued");
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
            <div key={t.id} className="tl__row">
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Atoms ────────────────────────────────────────────── */

function StatePill({ state }: { state: DesignTask["state"] }) {
  const color = STATE_COLOR[state];
  const isPulse = state === "running" || state === "needs-input";
  return (
    <span className="state-pill" style={{ color, background: `color-mix(in oklch, ${color}, var(--bg) 86%)` }}>
      <span className={"state-pill__dot" + (isPulse ? " state-pill__dot--pulse" : "")} style={{ background: color }} />
      {STATE_LABEL[state]}
    </span>
  );
}

function Delta({ delta }: { delta: string }) {
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
