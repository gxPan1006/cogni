/**
 * ProjectsList — main-slot view when the user is in project mode and no
 * project is open.
 *
 * Layout:
 *   ┌─── header (title + search + new) ─────────────────────────┐
 *   ├─── 📌 PINNED ──────────────────────────────────────────────┤
 *   │     [project card]  [project card]  [project card]        │
 *   ├─── 进行中 ───────────────────────────────────────────────────┤
 *   │     [project card]  …                                      │
 *   ├─── 已归档  (collapsible) ──────────────────────────────────┤
 *   │     [project card]  …                                      │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Sorting: health=warn|error projects float to the top of "进行中" so a sea of
 * normal projects can't hide a fire. Pinned uses author order.
 */
import { useMemo, useState } from "react";
import type { DesignProject } from "./mock.js";
import { MOCK_PROJECTS } from "./mock.js";
import { Icon } from "@cogni/ui";
import "./projects-list.css";

export function ProjectsList({
  projects = MOCK_PROJECTS,
  onOpen,
  onNew,
}: {
  projects?: DesignProject[];
  onOpen?: (id: string) => void;
  onNew?: () => void;
}) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((p) =>
      p.name.toLowerCase().includes(needle) ||
      (p.description ?? "").toLowerCase().includes(needle));
  }, [projects, q]);

  const pinned = filtered.filter((p) => p.pinned && !p.archived);
  const active = filtered
    .filter((p) => !p.pinned && !p.archived)
    .sort((a, b) => healthRank(b.health) - healthRank(a.health));
  const archived = filtered.filter((p) => p.archived);

  if (projects.length === 0) {
    return <EmptyAll onNew={onNew} />;
  }

  return (
    <div className="projects-list">
      <header className="projects-list__head">
        <div className="projects-list__head-text">
          <div className="projects-list__eyebrow">PROJECTS</div>
          <h1 className="projects-list__title">我的项目</h1>
          <p className="projects-list__intro">
            每个项目下挂一组任务,各自跑在 runner 上。Cogni 监督每条 runner、必要时叫你。
          </p>
        </div>
        <div className="projects-list__head-tools">
          <div className="projects-list__search">
            <span className="projects-list__search-icon">{Icon.search}</span>
            <input
              className="projects-list__search-input"
              placeholder="搜索项目"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" onClick={onNew}>
            {Icon.plus} 新项目
          </button>
        </div>
      </header>

      <div className="projects-list__body">
        {pinned.length > 0 && (
          <Section title="PINNED" icon={Icon.spark}>
            <Grid projects={pinned} onOpen={onOpen} />
          </Section>
        )}

        <Section title="进行中" subtitle={`${active.length} 个`}>
          {active.length === 0
            ? <EmptyActive onNew={onNew} />
            : <Grid projects={active} onOpen={onOpen} />}
        </Section>

        {archived.length > 0 && (
          <Section
            title={`已归档 · ${archived.length}`}
            collapsible
            open={showArchived}
            onToggle={() => setShowArchived(!showArchived)}
          >
            {showArchived && <Grid projects={archived} onOpen={onOpen} dim />}
          </Section>
        )}
      </div>
    </div>
  );
}

// ─── Section wrapper ─────────────────────────────────────

function Section({
  title, subtitle, icon, children,
  collapsible, open, onToggle,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const headInner = (
    <>
      {icon && <span className="projects-list__section-icon">{icon}</span>}
      <span className="projects-list__section-title">{title}</span>
      {subtitle && <span className="projects-list__section-sub">{subtitle}</span>}
      {collapsible && (
        <span className="projects-list__section-chev">{open ? "−" : "+"}</span>
      )}
    </>
  );
  return (
    <section className="projects-list__section">
      {collapsible
        ? <button className="projects-list__section-head projects-list__section-head--button" onClick={onToggle}>{headInner}</button>
        : <div   className="projects-list__section-head">{headInner}</div>}
      {children}
    </section>
  );
}

// ─── Grid + card ─────────────────────────────────────────

function Grid({ projects, onOpen, dim }: { projects: DesignProject[]; onOpen?: (id: string) => void; dim?: boolean }) {
  return (
    <div className={"projects-list__grid" + (dim ? " projects-list__grid--dim" : "")}>
      {projects.map((p) => <ProjectCard key={p.id} project={p} onOpen={onOpen} />)}
    </div>
  );
}

function ProjectCard({ project, onOpen }: { project: DesignProject; onOpen?: (id: string) => void }) {
  const totalRunners = project.liveRunners + project.queuedCount;
  const sourceLabel = project.source ? {
    linear: "Linear",
    internal: "Internal tracker",
    manual: "手动",
  }[project.source.kind] : "—";

  return (
    <button className="project-card" onClick={() => onOpen?.(project.id)}>
      <div className="project-card__head">
        <span className={`project-card__health project-card__health--${project.health}`} title={`Health: ${project.health}`} />
        {project.needsInputCount > 0 && (
          <span className="project-card__needs-input" title={`${project.needsInputCount} 个任务在等你`}>
            <span className="project-card__needs-input-dot" />
            {project.needsInputCount}
          </span>
        )}
      </div>
      <div className="project-card__name">{project.name}</div>
      {project.description && (
        <p className="project-card__desc">{project.description}</p>
      )}
      <div className="project-card__meta">
        <span className="project-card__meta-cell">
          <span className="project-card__meta-num">{project.liveRunners}</span>
          <span className="project-card__meta-label">在跑</span>
        </span>
        <span className="project-card__meta-sep">·</span>
        <span className="project-card__meta-cell">
          <span className="project-card__meta-num">{project.queuedCount}</span>
          <span className="project-card__meta-label">排队</span>
        </span>
        {totalRunners === 0 && project.health === "ok" && (
          <>
            <span className="project-card__meta-sep">·</span>
            <span className="project-card__meta-idle">空闲</span>
          </>
        )}
      </div>
      <div className="project-card__foot">
        <span className="project-card__source">{sourceLabel}</span>
        <span className="project-card__time">{project.updatedAt}</span>
      </div>
    </button>
  );
}

// ─── Empty states ────────────────────────────────────────

function EmptyAll({ onNew }: { onNew?: () => void }) {
  return (
    <div className="projects-list projects-list--empty">
      <div className="projects-list__empty">
        <div className="projects-list__empty-art">{Icon.kanban}</div>
        <h2 className="projects-list__empty-title">还没有项目</h2>
        <p className="projects-list__empty-text">
          项目就是一组让 Cogni 持续跑的任务 —— 接 Linear、内部 tracker,或直接手动加。
        </p>
        <button className="btn btn-primary" onClick={onNew}>
          {Icon.plus} 创建第一个项目
        </button>
      </div>
    </div>
  );
}

function EmptyActive({ onNew }: { onNew?: () => void }) {
  return (
    <div className="projects-list__empty-active">
      <div className="projects-list__empty-active-text">没有进行中的项目。</div>
      {onNew && <button className="btn btn-sm" onClick={onNew}>{Icon.plus} 新项目</button>}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────

function healthRank(h: DesignProject["health"]): number {
  if (h === "error") return 2;
  if (h === "warn") return 1;
  return 0;
}
