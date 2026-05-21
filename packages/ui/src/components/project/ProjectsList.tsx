/**
 * ProjectsList — main-slot view when the user is in project mode and no
 * project is open.
 *
 * Visual / layout: identical to the SP-1/PR-#11 mock-driven version
 * (`apps/desktop/src/ProjectsList.tsx`, now deleted). Only the data source
 * changed: instead of importing `MOCK_PROJECTS`, callers pass `items` —
 * each item bundles the contract `Project` row with the four derived
 * counters that drive the card visuals (`liveRunners` / `queuedCount` /
 * `needsInputCount` / `health`). Pinned/archived are read off the same
 * item shape so the SP-3 backend can ship these flags later without
 * touching this file.
 *
 * Wiring expectations:
 *   - Desktop Shell / web App build `items` by combining `useProjects()`
 *     with whatever per-project task stats are available (SP-3 MVP can
 *     pass zeros for the counters; the layout still works — empty
 *     "进行中" section + idle cards).
 *   - `onOpen` navigates into the project board. `onNew` opens the
 *     <NewProject> modal at the parent level.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project } from "@cogni/contract";
import { Icon } from "../icons.js";
import { LoadingState } from "../LoadingState.js";
import "./projects-list.css";

export type ProjectHealth = "ok" | "warn" | "error";

/**
 * A row in the projects list. `project` is the contract row; the rest are
 * UI-only counters the caller computes from the user's task stream.
 */
export interface ProjectListItem {
  project: Project;
  liveRunners: number;
  queuedCount: number;
  needsInputCount: number;
  health: ProjectHealth;
  pinned?: boolean;
  /** Display-only last-touch hint (e.g. "12m ago"); callers format the timestamp. */
  updatedAtLabel?: string;
}

export function ProjectsList({
  items,
  loading = false,
  onOpen,
  onNew,
  onPrefetch,
}: {
  items: ProjectListItem[];
  loading?: boolean;
  onOpen?: (id: string) => void;
  onNew?: () => void;
  /** Hover-prefetch a project's board into the SWR cache (flash-free open). */
  onPrefetch?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((it) =>
      it.project.name.toLowerCase().includes(needle) ||
      (it.project.description ?? "").toLowerCase().includes(needle));
  }, [items, q]);

  const isArchived = (it: ProjectListItem) => it.project.archivedAt !== null;
  const pinned   = filtered.filter((it) => it.pinned && !isArchived(it));
  const active   = filtered
    .filter((it) => !it.pinned && !isArchived(it))
    .sort((a, b) => healthRank(b.health) - healthRank(a.health));
  const archived = filtered.filter(isArchived);

  if (loading && items.length === 0) {
    return <ProjectsListLoading onNew={onNew} />;
  }

  if (!loading && items.length === 0) {
    return <EmptyAll onNew={onNew} />;
  }

  return (
    <div className={"projects-list" + (loading ? " projects-list--busy" : "")} aria-busy={loading}>
      <header className="projects-list__head">
        <div className="projects-list__head-text">
          <div className="projects-list__eyebrow">{t("project.list.eyebrow")}</div>
          <h1 className="projects-list__title">{t("project.list.title")}</h1>
          <p className="projects-list__intro">
            {t("project.list.intro")}
          </p>
        </div>
        <div className="projects-list__head-tools">
          <div className="projects-list__search">
            <span className="projects-list__search-icon">{Icon.search}</span>
            <input
              className="projects-list__search-input"
              placeholder={t("project.list.searchPlaceholder")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" onClick={onNew}>
            {Icon.plus} {t("project.list.newProject")}
          </button>
        </div>
      </header>

      <div className="projects-list__body">
        {loading && (
          <div className="projects-list__refreshing">
            <LoadingState variant="inline" title={t("project.list.refreshingTitle")} subtitle={t("project.list.refreshingSubtitle")} />
          </div>
        )}
        {pinned.length > 0 && (
          <Section title={t("project.list.pinned")} icon={Icon.spark}>
            <Grid items={pinned} onOpen={onOpen} onPrefetch={onPrefetch} />
          </Section>
        )}

        <Section title={t("project.list.active")} subtitle={t("project.list.activeCount", { n: active.length })}>
          {active.length === 0
            ? <EmptyActive onNew={onNew} />
            : <Grid items={active} onOpen={onOpen} onPrefetch={onPrefetch} />}
        </Section>

        {archived.length > 0 && (
          <Section
            title={t("project.list.archived", { n: archived.length })}
            collapsible
            open={showArchived}
            onToggle={() => setShowArchived(!showArchived)}
          >
            {showArchived && <Grid items={archived} onOpen={onOpen} onPrefetch={onPrefetch} dim />}
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

function Grid({ items, onOpen, onPrefetch, dim }: { items: ProjectListItem[]; onOpen?: (id: string) => void; onPrefetch?: (id: string) => void; dim?: boolean }) {
  return (
    <div className={"projects-list__grid" + (dim ? " projects-list__grid--dim" : "")}>
      {items.map((it) => <ProjectCard key={it.project.id} item={it} onOpen={onOpen} onPrefetch={onPrefetch} />)}
    </div>
  );
}

function ProjectCard({ item, onOpen, onPrefetch }: { item: ProjectListItem; onOpen?: (id: string) => void; onPrefetch?: (id: string) => void }) {
  const { t } = useTranslation();
  const { project, liveRunners, queuedCount, needsInputCount, health } = item;
  const totalRunners = liveRunners + queuedCount;
  const updatedAtLabel = item.updatedAtLabel ?? "";

  return (
    <button className="project-card" onClick={() => onOpen?.(project.id)} onMouseEnter={() => onPrefetch?.(project.id)}>
      <div className="project-card__head">
        <span className={`project-card__health project-card__health--${health}`} title={t("project.card.health", { health })} />
        {needsInputCount > 0 && (
          <span className="project-card__needs-input" title={t("project.card.needsInputTitle", { n: needsInputCount })}>
            <span className="project-card__needs-input-dot" />
            {needsInputCount}
          </span>
        )}
      </div>
      <div className="project-card__name">{project.name}</div>
      {project.description && (
        <p className="project-card__desc">{project.description}</p>
      )}
      <div className="project-card__meta">
        <span className="project-card__meta-cell">
          <span className="project-card__meta-num">{liveRunners}</span>
          <span className="project-card__meta-label">{t("project.card.running")}</span>
        </span>
        <span className="project-card__meta-sep">·</span>
        <span className="project-card__meta-cell">
          <span className="project-card__meta-num">{queuedCount}</span>
          <span className="project-card__meta-label">{t("project.card.queued")}</span>
        </span>
        {totalRunners === 0 && health === "ok" && (
          <>
            <span className="project-card__meta-sep">·</span>
            <span className="project-card__meta-idle">{t("project.card.idle")}</span>
          </>
        )}
      </div>
      <div className="project-card__foot">
        <span className="project-card__source">Cogni</span>
        <span className="project-card__time">{updatedAtLabel}</span>
      </div>
    </button>
  );
}

// ─── Empty states ────────────────────────────────────────

function EmptyAll({ onNew }: { onNew?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="projects-list projects-list--empty">
      <div className="projects-list__empty">
        <div className="projects-list__empty-art">{Icon.kanban}</div>
        <h2 className="projects-list__empty-title">{t("project.list.emptyTitle")}</h2>
        <p className="projects-list__empty-text">
          {t("project.list.emptyText")}
        </p>
        <button className="btn btn-primary" onClick={onNew}>
          {Icon.plus} {t("project.list.emptyCreate")}
        </button>
      </div>
    </div>
  );
}

function EmptyActive({ onNew }: { onNew?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="projects-list__empty-active">
      <div className="projects-list__empty-active-text">{t("project.list.emptyActive")}</div>
      {onNew && <button className="btn btn-sm" onClick={onNew}>{Icon.plus} {t("project.list.newProject")}</button>}
    </div>
  );
}

function ProjectsListLoading({ onNew }: { onNew?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="projects-list projects-list--loading" aria-busy="true">
      <header className="projects-list__head">
        <div className="projects-list__head-text">
          <div className="projects-list__eyebrow">{t("project.list.eyebrow")}</div>
          <h1 className="projects-list__title">{t("project.list.title")}</h1>
          <p className="projects-list__intro">
            {t("project.list.intro")}
          </p>
        </div>
        <div className="projects-list__head-tools">
          <button className="btn btn-primary" onClick={onNew}>
            {Icon.plus} {t("project.list.newProject")}
          </button>
        </div>
      </header>
      <div className="projects-list__body">
        <LoadingState variant="section" title={t("project.list.syncingTitle")} subtitle={t("project.list.syncingSubtitle")} />
        <div className="projects-list__grid projects-list__grid--loading">
          {Array.from({ length: 6 }, (_, i) => <ProjectCardSkeleton key={i} />)}
        </div>
      </div>
    </div>
  );
}

function ProjectCardSkeleton() {
  return (
    <div className="project-card project-card--skeleton">
      <div className="project-card__head">
        <span className="project-card__health loading-skeleton" />
        <span className="project-card__chip-skeleton loading-skeleton" />
      </div>
      <span className="project-card__name-skeleton loading-skeleton" />
      <span className="project-card__desc-skeleton loading-skeleton" />
      <span className="project-card__desc-skeleton project-card__desc-skeleton--short loading-skeleton" />
      <div className="project-card__meta">
        <span className="project-card__metric-skeleton loading-skeleton" />
        <span className="project-card__metric-skeleton project-card__metric-skeleton--short loading-skeleton" />
      </div>
      <div className="project-card__foot">
        <span className="project-card__foot-skeleton loading-skeleton" />
        <span className="project-card__foot-skeleton project-card__foot-skeleton--short loading-skeleton" />
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────

function healthRank(h: ProjectHealth): number {
  if (h === "error") return 2;
  if (h === "warn") return 1;
  return 0;
}
