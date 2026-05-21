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
import type { ProjectTask, TaskState, Project } from "@cogni/contract";
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

// Stepper steps, keyed by state. Labels are translated at render time via the
// `labelKey` so switching language updates instantly (the stepper's labels
// differ slightly from the generic STATE_LABEL — e.g. "Review" / "完成").
const STEPPER: { state: TaskState; labelKey: string }[] = [
  { state: "queued",      labelKey: "project.task.stepQueued" },
  { state: "running",     labelKey: "project.task.stepRunning" },
  { state: "needs-input", labelKey: "project.task.stepNeedsInput" },
  { state: "reviewing",   labelKey: "project.task.stepReviewing" },
  { state: "done",        labelKey: "project.task.stepDone" },
];

/** Translate a TaskState to its drawer-card label at render time. */
function drawerStateLabel(t: TFunction, state: TaskState): string {
  return t(`project.state.${state}`);
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

          {/* 主页面: status stepper, activity card, needs-input, actions. */}
          {task && activeTab === "overview" && (
            <>
              <Stepper currentState={task.state} />
              <ActivityCard task={task} />
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
              <Actions task={task} onAccept={detail.accept} onReject={detail.reject} onRetry={detail.retry} onCancel={detail.cancel} />
              <TaskComments api={api} taskId={taskId} />
            </>
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

function Stepper({ currentState }: { currentState: TaskState }) {
  const { t } = useTranslation();
  const isFailed = currentState === "failed";
  const isCancelled = currentState === "cancelled";
  const effective: TaskState = isFailed || isCancelled ? "running" : currentState;
  const currentIdx = STEPPER.findIndex((s) => s.state === effective);

  return (
    <ol className="td-stepper">
      {STEPPER.map((s, i) => {
        const cls = "td-stepper__step"
          + (i < currentIdx  ? " td-stepper__step--past"    : "")
          + (i === currentIdx ? " td-stepper__step--current" : "")
          + ((isFailed || isCancelled) && i === currentIdx ? " td-stepper__step--failed" : "");
        return (
          <li key={s.state} className={cls}>
            <span className="td-stepper__dot" />
            <span className="td-stepper__label">{t(s.labelKey)}</span>
            {i < STEPPER.length - 1 && <span className="td-stepper__line" />}
          </li>
        );
      })}
    </ol>
  );
}

function ActivityCard({ task }: { task: ProjectTask }) {
  const { t } = useTranslation();
  const elapsed = formatElapsed(task);
  const progress =
    task.state === "done" || task.state === "reviewing" ? 1 :
    task.state === "running" || task.state === "failed" ? 0.5 : 0;
  return (
    <div className="td-card">
      <div className="td-card__head">
        <span className="td-card__head-label">{t("project.task.currentActivity")}</span>
        <span className="td-card__head-time">{elapsed ?? "—"}</span>
      </div>
      <div className="td-card__activity">
        {task.needsInputWhat ?? drawerStateLabel(t, task.state)}
      </div>
      {(task.state === "running" || task.state === "reviewing" || task.state === "failed") && (
        <div className="kb-progress td-card__progress">
          <div className="kb-progress__fill" style={{
            width: `${progress * 100}%`,
            background: task.state === "failed" ? "var(--bad)" : "var(--accent)",
          }} />
        </div>
      )}
      <div className="td-card__metrics">
        <Metric label={t("project.task.metricState")}>{drawerStateLabel(t, task.state)}</Metric>
        <Metric label={t("project.task.metricRetry")} tone={task.retries > 0 ? "warn" : "muted"}>{task.retries} / {task.maxRetries}</Metric>
        <Metric label={t("project.task.metricAttempt")}>#{task.retries + 1}</Metric>
      </div>
    </div>
  );
}

function Metric({ label, tone, children }: { label: string; tone?: "muted" | "warn"; children: React.ReactNode }) {
  return (
    <div className="td-metric">
      <div className="td-metric__label">{label.toUpperCase()}</div>
      <div className={"td-metric__value" + (tone ? ` td-metric__value--${tone}` : "")}>{children}</div>
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
