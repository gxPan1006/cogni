/**
 * TaskDetail — right-side drawer for one task.
 *
 * (Lifted from apps/desktop/src/TaskDetail.tsx so apps/web can use it too.
 *  Visual treatment unchanged — header, stepper, activity card, action row,
 *  embedded thread — only data sources are real now.)
 *
 * Composition:
 *   - The page-level Shell owns `activeTaskId` and renders TaskDetail when
 *     non-null. The drawer subscribes to `useTaskDetail(api, taskId)` for
 *     the live task row + runs history, and to `useThreadStream(api,
 *     task.executionThreadId)` for the runner event stream that fills the
 *     embedded thread section.
 *   - Action buttons (Accept / Reject / Retry / Cancel / 重试 etc) call the
 *     mutator functions returned by `useTaskDetail` — the server's lifecycle
 *     state machine drives the row's actual transition, which streams back
 *     in via the `task-event` subscription and re-renders the drawer.
 *
 * Keyboard:
 *   - Esc closes
 *   - ←/→ cycle to adjacent tasks (if `allTaskIds` is provided by the board)
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ProjectTask, TaskRun, TaskExitReason, Priority, Project } from "@cogni/contract";
import type { ApiClient, HostInfo } from "../../transport/api.js";
import { useTaskDetail, type UseTaskDetailResult } from "../../hooks/useTaskDetail.js";
import { useThreadStream } from "../../hooks/useThreadStream.js";
import { useUploads } from "../../hooks/useUploads.js";
import { Composer } from "../Composer.js";
import { Icon } from "../icons.js";
import { ArtifactBrowser } from "./ArtifactBrowser.js";
import {
  UserMessage, AssistantText, AssistantBlocks, buildTimeline,
} from "../ChatBlocks.js";
import { Markdown } from "../Markdown.js";
import { StatePill, STATE_COLOR } from "./ProjectBoard.js";
import { TaskComments } from "./TaskComments.js";
import { LoadingRows, LoadingState } from "../LoadingState.js";
import "../conversation.css";
import "./task-detail.css";

// Priority → { label key, fill level (0–4 bars lit) }. Mirrors the Linear
// numeric scale documented on `Priority` (0=none, 1=urgent … 4=low) — urgent
// fills all bars in red, the rest fill bottom-up.
const PRIO_META: Record<Priority, { key: string; level: number }> = {
  0: { key: "prioNone",   level: 0 },
  1: { key: "prioUrgent", level: 4 },
  2: { key: "prioHigh",   level: 3 },
  3: { key: "prioMedium", level: 2 },
  4: { key: "prioLow",    level: 1 },
};

/** Translate a TaskRun exit reason to its timeline label. */
function exitReasonLabel(t: TFunction, r: TaskExitReason | null): string {
  switch (r) {
    case "failed":                 return t("project.task.exitFailed");
    case "timeout":                return t("project.task.exitTimeout");
    case "host-disconnect":        return t("project.task.exitHostDisconnect");
    case "cancelled":              return t("project.task.exitCancelled");
    case "business-clarification": return t("project.task.exitBusinessClarification");
    case "done":
    default:                       return t("project.task.exitDone");
  }
}

export function TaskDetail({
  api,
  taskId,
  project,
  hosts = [],
  allTaskIds,
  onClose,
  onNavigate,
}: {
  api: ApiClient;
  taskId: string;
  /** The task's parent project. Used for the breadcrumb / header subtitle. */
  project?: Project | null;
  hosts?: HostInfo[];
  allTaskIds?: string[];
  onClose: () => void;
  onNavigate?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const detail = useTaskDetail(api, taskId);
  const task = detail.task;
  const [tab, setTab] = useState<"overview" | "thread" | "files">("overview");

  // Keyboard: Esc / ← / →
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (!allTaskIds || !onNavigate) return;
      const idx = allTaskIds.indexOf(taskId);
      if (idx < 0) return;
      if (e.key === "ArrowLeft"  && idx > 0)                       onNavigate(allTaskIds[idx - 1]!);
      if (e.key === "ArrowRight" && idx < allTaskIds.length - 1)  onNavigate(allTaskIds[idx + 1]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, allTaskIds, onClose, onNavigate]);

  const host = task?.hostId ? hosts.find((h) => h.id === task.hostId) : undefined;
  const idx     = allTaskIds?.indexOf(taskId) ?? -1;
  const total   = allTaskIds?.length ?? 0;

  const hasThread = !!task?.executionThreadId;
  // SP-4 Artifacts: files exist at the worktree while reviewing (new files live
  // there pre-merge), falling back to the project repo root once done.
  const hasFiles  = !!task && (task.state === "reviewing" || task.state === "done" || task.state === "running");
  // 主页面 (overview) is always available; 执行记录 / 文件 only when they have
  // content. Fall back to overview if the active tab isn't available.
  const activeTab: "overview" | "thread" | "files" =
    tab === "thread" && hasThread ? "thread"
    : tab === "files" && hasFiles ? "files"
    : "overview";

  return (
    <div className="td-scrim" onClick={onClose}>
      <aside className="td" role="dialog" aria-label={`Task ${task?.ref ?? ""}`} onClick={(e) => e.stopPropagation()}>
        <header className="td__head">
          <div className="td__head-nav">
            <button className="td__icon-btn" onClick={onClose} title={t("project.task.close")}>{Icon.x}</button>
            {allTaskIds && total > 1 && (
              <div className="td__pager">
                <button
                  className="td__icon-btn"
                  disabled={idx <= 0}
                  onClick={() => idx > 0 && onNavigate?.(allTaskIds[idx - 1]!)}
                  title={t("project.task.prevTask")}
                >
                  <span style={{ transform: "rotate(180deg)", display: "inline-flex" }}>{Icon.arrow}</span>
                </button>
                <span className="td__pager-count">{idx + 1} / {total}</span>
                <button
                  className="td__icon-btn"
                  disabled={idx >= total - 1}
                  onClick={() => idx < total - 1 && onNavigate?.(allTaskIds[idx + 1]!)}
                  title={t("project.task.nextTask")}
                >
                  {Icon.arrow}
                </button>
              </div>
            )}
          </div>
          <div className="td__head-body">
            <div className="td__head-meta">
              <span className="td__ref">{task?.ref ?? "…"}</span>
              <span className="td__sep">·</span>
              <span className="td__project">{project?.name ?? task?.projectId ?? ""}</span>
            </div>
            <h2 className="td__title">
              {task?.title ?? (
                detail.loading
                  ? <span className="td__title-skeleton loading-skeleton" aria-hidden="true" />
                  : t("project.task.notFound")
              )}
            </h2>
            {task && (
              <div className="td__head-row">
                <StatePill state={task.state} />
                {host && (
                  <span className="td__host">
                    <span className={"dot " + (host.status === "online" ? "dot-online" : "dot-offline")} />
                    <span>{host.name}</span>
                  </span>
                )}
                {task.startedAt && <span className="td__started">{t("project.task.started", { ago: formatAgo(task.startedAt) })}</span>}
              </div>
            )}
          </div>
        </header>

        {/* 主页面 / 执行记录 / 文件 — fixed tab strip; switching tabs swaps the
            scroll body below without resizing the modal. */}
        {task && (
          <div className="td-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={activeTab === "overview"}
              className={"td-tab" + (activeTab === "overview" ? " is-on" : "")}
              onClick={() => setTab("overview")}
            >{t("project.task.tabOverview")}</button>
            {hasThread && (
              <button
                role="tab"
                aria-selected={activeTab === "thread"}
                className={"td-tab" + (activeTab === "thread" ? " is-on" : "")}
                onClick={() => setTab("thread")}
              >{t("project.task.tabThread")}</button>
            )}
            {hasFiles && (
              <button
                role="tab"
                aria-selected={activeTab === "files"}
                className={"td-tab" + (activeTab === "files" ? " is-on" : "")}
                onClick={() => setTab("files")}
              >{t("project.task.tabFiles")}</button>
            )}
          </div>
        )}

        <div className={"td__scroll" + (task && activeTab !== "overview" ? " td__scroll--flush" : "")}>
          {detail.loading && !task && <TaskDetailLoading />}
          {!detail.loading && !task && (
            <div className="td-card td-card--empty">{t("project.task.notFoundBody")}</div>
          )}

          {/* 主页面: two-pane — content (description / activity / files / comments)
              on the left, action buttons + metadata sidebar on the right. */}
          {task && activeTab === "overview" && (
            <div className="td-pane">
              <div className="td-pane__main">
                {task.state === "needs-input" && (
                  <div className="td-needs">
                    <div className="td-needs__head">
                      <span className="td-needs__icon">{Icon.shield}</span>
                      <span className="td-needs__label">{t("project.task.needsInputLabel")}</span>
                    </div>
                    {task.needsInputWhat && <div className="td-needs__body">{task.needsInputWhat}</div>}
                    <TaskReply api={api} taskId={taskId} reply={detail.reply} />
                    <div className="td-needs__actions">
                      <button className="btn btn-sm" onClick={() => { void detail.cancel(); }}>{t("project.task.cancelTask")}</button>
                    </div>
                  </div>
                )}

                <section className="td-sec">
                  <div className="td-sec__h">{t("project.task.secDescription")}</div>
                  {task.description
                    ? <div className="td-desc"><Markdown text={task.description} /></div>
                    : <div className="td-desc td-desc--empty">{t("project.task.noDescription")}</div>}
                </section>

                <section className="td-sec">
                  <div className="td-sec__h">{t("project.task.secActivity")}</div>
                  <TaskTimeline task={task} runs={detail.runs} />
                </section>

                {hasFiles && (
                  <section className="td-sec">
                    <div className="td-sec__h">{t("project.task.secFileChanges")}</div>
                    <button type="button" className="td-files-link" onClick={() => setTab("files")}>
                      {Icon.folder}{t("project.task.viewFiles")}
                    </button>
                  </section>
                )}

                <TaskComments api={api} taskId={taskId} />
              </div>

              <aside className="td-pane__side">
                <div className="td-side-actions">
                  <Actions task={task} onAccept={detail.accept} onReject={detail.reject} onRetry={detail.retry} onCancel={detail.cancel} />
                </div>
                <MetaSidebar task={task} host={host} />
              </aside>
            </div>
          )}

          {/* 执行记录: the runner thread, rendered with the same chat styling. */}
          {task && activeTab === "thread" && hasThread && (
            <ThreadSection api={api} threadId={task.executionThreadId!} />
          )}

          {/* 文件: SP-4 artifacts browser. */}
          {task && activeTab === "files" && hasFiles && (
            <ArtifactBrowser
              api={api}
              source={{
                kind: "project",
                projectId: task.projectId,
                ...(task.worktreePath ? { startPath: task.worktreePath } : {}),
              }}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

/* ─── Subcomponents ──────────────────────────────────── */

/**
 * Reply composer shown inside the `needs-input` card. Reuses the shared
 * <Composer> so the attach button + drag-drop tray behave exactly like chat:
 * the user can drop/pick files (streamed to the task's host via
 * `api.uploadTaskFile`, staged under the task's executionThreadId), then types
 * a reply and hits send. On submit we take the committed attachments and POST
 * them with the reply — the cloud names them on the dispatch so the runner
 * sees them under ./.cogni-uploads/ in its worktree.
 *
 * Visible behavior: file pills with progress bars appear above the textarea;
 * send is disabled while any upload is in flight; after send the textarea +
 * tray clear and the task transitions back to `running` (the card disappears
 * once the `task-event` lands).
 */
function TaskReply({
  api,
  taskId,
  reply,
}: {
  api: ApiClient;
  taskId: string;
  reply: UseTaskDetailResult["reply"];
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const uploads = useUploads((file, onProgress) => api.uploadTaskFile(taskId, file, onProgress));

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const attachments = uploads.takeAttachments();
    setDraft("");
    void reply(text, attachments.length > 0 ? attachments : undefined);
  };

  return (
    <div className="td-needs__reply">
      <Composer
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        placeholder={t("project.task.replyPlaceholder")}
        uploads={uploads}
      />
    </div>
  );
}

function TaskDetailLoading() {
  const { t } = useTranslation();
  return (
    <>
      <LoadingState variant="section" title={t("project.task.loadingTitle")} subtitle={t("project.task.loadingSubtitle")} />
      <div className="td-card td-card--loading">
        <LoadingRows rows={3} compact />
      </div>
      <div className="td-thread td-thread--loading">
        <div className="td-thread__head">
          <span>{t("project.task.runnerThread")}</span>
        </div>
        <LoadingRows rows={2} compact />
      </div>
    </>
  );
}

/**
 * Activity timeline — a real, timestamp-derived event rail (newest first).
 * Built from the task's own timestamps (`createdAt`, `updatedAt`,
 * `completedAt`) plus the `runs` history (each attempt's start + how it
 * ended, with the runner's `errorMessage` shown inline on failures). This
 * replaces the old hardcoded 5-dot stepper + fake 0/0.5/1 progress bar —
 * everything here is genuine data already on the wire.
 *
 * Visible behavior: the user sees a vertical timeline; the top (current) row
 * gets a live pulsing dot while the task is running, failed-attempt rows show
 * a red dot and the failure reason/message, finished work shows a green dot.
 */
function TaskTimeline({ task, runs }: { task: ProjectTask; runs: TaskRun[] }) {
  const { t } = useTranslation();
  type Tone = "live" | "good" | "bad" | "plain";
  const entries: { ts: number; what: string; detail?: string | null; tone: Tone }[] = [];
  const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

  entries.push({ ts: at(task.createdAt), what: t("project.task.tlQueued"), tone: "plain" });

  [...runs].sort((a, b) => a.attemptNumber - b.attemptNumber).forEach((run) => {
    entries.push({ ts: at(run.startedAt), what: t("project.task.tlAttemptStarted", { n: run.attemptNumber }), tone: "plain" });
    if (run.endedAt) {
      const bad = run.exitReason === "failed" || run.exitReason === "timeout" || run.exitReason === "host-disconnect";
      entries.push({ ts: at(run.endedAt), what: exitReasonLabel(t, run.exitReason), detail: run.errorMessage, tone: bad ? "bad" : "good" });
    }
  });

  // Head row for the current state. Ongoing states (running / needs-input /
  // reviewing) pulse; a completed task gets a terminal "done" row.
  if (task.state === "running" || task.state === "needs-input" || task.state === "reviewing") {
    const label =
      task.state === "running"     ? t("project.task.tlRunning")
      : task.state === "needs-input" ? t("project.task.tlNeedsInput")
      :                                t("project.task.tlReviewing");
    entries.push({ ts: at(task.updatedAt), what: label, tone: "live" });
  } else if (task.state === "done" && task.completedAt) {
    entries.push({ ts: at(task.completedAt), what: t("project.task.tlCompleted"), tone: "good" });
  }

  const rows = entries.filter((e) => Number.isFinite(e.ts)).sort((a, b) => b.ts - a.ts);
  if (rows.length === 0) return <div className="td-tl__empty">{t("project.task.noActivity")}</div>;

  return (
    <ol className="td-tl">
      {rows.map((e, i) => (
        <li key={i} className={"td-tl__item td-tl__item--" + e.tone}>
          <span className="td-tl__when">{formatClock(e.ts)}</span>
          <div className="td-tl__body">
            <div className="td-tl__what">{e.what}</div>
            {e.detail && <div className="td-tl__detail">{e.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Linear-style priority glyph: three bars lit bottom-up, urgent in red. */
function PriorityGlyph({ priority }: { priority: Priority }) {
  const { t } = useTranslation();
  const meta = PRIO_META[priority];
  return (
    <span className={"td-prio" + (priority === 1 ? " td-prio--urgent" : "")}>
      <span className="td-prio__bars" data-level={meta.level}><i /><i /><i /></span>
      <span>{t("project.task." + meta.key)}</span>
    </span>
  );
}

/** Right-side metadata column — surfaces the ProjectTask fields the old
 *  drawer never showed (priority, labels, adapter, branch) alongside host,
 *  attempts, created-at and elapsed. */
function MetaSidebar({ task, host }: { task: ProjectTask; host?: HostInfo }) {
  const { t } = useTranslation();
  const none = <span className="td-meta__none">{t("project.task.metaNone")}</span>;
  const elapsed = formatElapsed(task);
  return (
    <dl className="td-meta">
      <MetaRow k={t("project.task.metaState")}><StatePill state={task.state} /></MetaRow>
      <MetaRow k={t("project.task.metaPriority")}><PriorityGlyph priority={task.priority} /></MetaRow>
      <MetaRow k={t("project.task.metaLabels")}>
        {task.labels.length > 0
          ? <span className="td-labels">{task.labels.map((l) => <span key={l} className="td-label">{l}</span>)}</span>
          : none}
      </MetaRow>
      <MetaRow k={t("project.task.metaAgent")}>{task.adapter ?? none}</MetaRow>
      <MetaRow k={t("project.task.metaHost")}>
        {host
          ? <span className="td-meta__host"><span className={"dot " + (host.status === "online" ? "dot-online" : "dot-offline")} />{host.name}</span>
          : <span className="td-meta__none">{t("project.task.metaUnassigned")}</span>}
      </MetaRow>
      <MetaRow k={t("project.task.metaBranch")}>{task.branchName ? <span className="td-meta__mono">{task.branchName}</span> : none}</MetaRow>
      <MetaRow k={t("project.task.metaAttempts")}>{task.retries + 1} / {task.maxRetries + 1}</MetaRow>
      <MetaRow k={t("project.task.metaCreated")}>{formatDateTime(task.createdAt)}</MetaRow>
      <MetaRow k={t("project.task.metaElapsed")}>{elapsed ?? none}</MetaRow>
    </dl>
  );
}

function MetaRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="td-meta__row">
      <dt className="td-meta__k">{k}</dt>
      <dd className="td-meta__v">{children}</dd>
    </div>
  );
}

function Actions({ task, onAccept, onReject, onRetry, onCancel }: {
  task: ProjectTask;
  onAccept: () => Promise<void>;
  onReject: () => Promise<void>;
  onRetry:  () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const actions: { label: string; tone?: "primary" | "danger" | "ghost"; icon?: React.ReactNode; onClick?: () => void }[] = [];

  if (task.state === "queued") {
    actions.push({ label: t("project.task.actionCancel"), tone: "ghost", icon: Icon.x, onClick: () => { void onCancel(); } });
  } else if (task.state === "running") {
    actions.push({ label: t("project.task.actionAbort"), tone: "danger", icon: Icon.x, onClick: () => { void onCancel(); } });
  } else if (task.state === "reviewing") {
    actions.push({ label: t("project.task.actionAcceptMerge"), tone: "primary", icon: Icon.check, onClick: () => { void onAccept(); } });
    actions.push({ label: t("project.task.actionReject"),                  icon: Icon.x,     onClick: () => { void onReject(); } });
    actions.push({ label: t("project.task.actionRetry"),                       icon: Icon.refresh, onClick: () => { void onRetry(); } });
  } else if (task.state === "failed") {
    actions.push({ label: t("project.task.actionRetry"), tone: "primary", icon: Icon.refresh, onClick: () => { void onRetry(); } });
    actions.push({ label: t("project.task.actionCancelTask"), tone: "ghost", icon: Icon.x, onClick: () => { void onCancel(); } });
  } else if (task.state === "done") {
    actions.push({ label: t("project.task.actionRunAgain"), icon: Icon.refresh, onClick: () => { void onRetry(); } });
  }

  if (actions.length === 0) return null;
  return (
    <div className="td-actions">
      {actions.map((a, i) => (
        <button
          key={i}
          onClick={a.onClick}
          className={
            "btn btn-sm"
            + (a.tone === "primary" ? " btn-primary" : "")
            + (a.tone === "ghost"   ? " btn-ghost"   : "")
            + (a.tone === "danger"  ? " td-actions__danger" : "")
          }
        >
          {a.icon}{a.label}
        </button>
      ))}
    </div>
  );
}

function ThreadSection({ api, threadId }: { api: ApiClient; threadId: string }) {
  const { t } = useTranslation();
  const { messages, events, loading } = useThreadStream(api, threadId);
  const { rows } = buildTimeline(messages, events);
  if (rows.length === 0) {
    return (
      <div className="conversation__list td-thread__list">
        {loading
          ? <LoadingRows rows={3} />
          : <div className="conversation__empty">{t("project.task.runnerSilent")}</div>}
      </div>
    );
  }
  // Same chat blocks + container as the main Conversation, so the execution
  // record reads identically to a normal chat (full-size bubbles + tool pills).
  return (
    <div className="conversation__list td-thread__list">
      {rows.map((row) => {
        if (row.kind === "user") return <UserMessage key={row.key} text={row.text} attachments={row.attachments} />;
        if (row.kind === "system") {
          return (
            <div key={row.key} className="msg msg--aux">
              <div className="conversation__system"><Markdown text={row.text} /></div>
            </div>
          );
        }
        if (row.kind === "assistant-text") return <AssistantText key={row.key} text={row.text} />;
        return <AssistantBlocks key={row.key} blocks={row.blocks} streaming={row.streaming} />;
      })}
    </div>
  );
}

// ─── Time helpers ────────────────────────────────────────────────────────────

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** HH:MM from an epoch-ms timestamp, for timeline rows. */
function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** MM-DD HH:MM from an ISO string, for the metadata sidebar's created-at. */
function formatDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatElapsed(t: ProjectTask): string | null {
  if (!t.startedAt) return null;
  const start = Date.parse(t.startedAt);
  const end = t.completedAt ? Date.parse(t.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const r = secs % 60;
  if (mins < 60) return `${mins}m ${r}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Re-export so callers don't have to know about the internal map for typing.
export { STATE_COLOR };
