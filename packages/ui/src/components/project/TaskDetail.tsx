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
import { LoadingRows, LoadingState } from "../LoadingState.js";
import "./task-detail.css";

const STEPPER: { state: TaskState; label: string }[] = [
  { state: "queued",      label: "排队中" },
  { state: "running",     label: "进行中" },
  { state: "needs-input", label: "等待输入" },
  { state: "reviewing",   label: "Review" },
  { state: "done",        label: "完成" },
];

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
  const detail = useTaskDetail(api, taskId);
  const task = detail.task;
  const [tab, setTab] = useState<"thread" | "files">("thread");

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
  const activeTab: "thread" | "files" =
    tab === "files" && hasFiles ? "files"
    : tab === "thread" && hasThread ? "thread"
    : hasThread ? "thread" : "files";

  return (
    <div className="td-scrim" onClick={onClose}>
      <aside className="td" role="dialog" aria-label={`Task ${task?.ref ?? ""}`} onClick={(e) => e.stopPropagation()}>
        <header className="td__head">
          <div className="td__head-nav">
            <button className="td__icon-btn" onClick={onClose} title="关闭 (Esc)">{Icon.x}</button>
            {allTaskIds && total > 1 && (
              <div className="td__pager">
                <button
                  className="td__icon-btn"
                  disabled={idx <= 0}
                  onClick={() => idx > 0 && onNavigate?.(allTaskIds[idx - 1]!)}
                  title="上一个任务 (←)"
                >
                  <span style={{ transform: "rotate(180deg)", display: "inline-flex" }}>{Icon.arrow}</span>
                </button>
                <span className="td__pager-count">{idx + 1} / {total}</span>
                <button
                  className="td__icon-btn"
                  disabled={idx >= total - 1}
                  onClick={() => idx < total - 1 && onNavigate?.(allTaskIds[idx + 1]!)}
                  title="下一个任务 (→)"
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
                  : "任务未找到"
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
                {task.startedAt && <span className="td__started">started {formatAgo(task.startedAt)}</span>}
              </div>
            )}
          </div>
        </header>

        <div className="td__scroll">
          {detail.loading && !task && <TaskDetailLoading />}
          {!detail.loading && !task && (
            <div className="td-card td-card--empty">这个任务不存在或已经被删除。</div>
          )}
          {task && <Stepper currentState={task.state} />}
          {task && <ActivityCard task={task} />}

          {task?.state === "needs-input" && (
            <div className="td-needs">
              <div className="td-needs__head">
                <span className="td-needs__icon">{Icon.shield}</span>
                <span className="td-needs__label">等你回应</span>
              </div>
              {task.needsInputWhat && <div className="td-needs__body">{task.needsInputWhat}</div>}
              <TaskReply api={api} taskId={taskId} reply={detail.reply} />
              <div className="td-needs__actions">
                <button className="btn btn-sm" onClick={() => { void detail.cancel(); }}>取消任务</button>
              </div>
            </div>
          )}

          {task && <Actions task={task} onAccept={detail.accept} onReject={detail.reject} onRetry={detail.retry} onCancel={detail.cancel} />}

          {/* 对话 / 文件 as tabs inside the modal (was two stacked sections). */}
          {task && (hasThread || hasFiles) && (
            <div className="td-tabs-wrap">
              <div className="td-tabs" role="tablist">
                {hasThread && (
                  <button
                    role="tab"
                    aria-selected={activeTab === "thread"}
                    className={"td-tab" + (activeTab === "thread" ? " is-on" : "")}
                    onClick={() => setTab("thread")}
                  >对话</button>
                )}
                {hasFiles && (
                  <button
                    role="tab"
                    aria-selected={activeTab === "files"}
                    className={"td-tab" + (activeTab === "files" ? " is-on" : "")}
                    onClick={() => setTab("files")}
                  >文件</button>
                )}
              </div>

              {activeTab === "thread" && hasThread && (
                <ThreadSection api={api} threadId={task.executionThreadId!} />
              )}
              {activeTab === "files" && hasFiles && (
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
        placeholder="回复 runner…"
        uploads={uploads}
      />
    </div>
  );
}

function TaskDetailLoading() {
  return (
    <>
      <LoadingState variant="section" title="正在加载任务详情" subtitle="同步任务状态、运行记录和执行对话" />
      <div className="td-card td-card--loading">
        <LoadingRows rows={3} compact />
      </div>
      <div className="td-thread td-thread--loading">
        <div className="td-thread__head">
          <span>RUNNER THREAD</span>
        </div>
        <LoadingRows rows={2} compact />
      </div>
    </>
  );
}

function Stepper({ currentState }: { currentState: TaskState }) {
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
            <span className="td-stepper__label">{s.label}</span>
            {i < STEPPER.length - 1 && <span className="td-stepper__line" />}
          </li>
        );
      })}
    </ol>
  );
}

function ActivityCard({ task }: { task: ProjectTask }) {
  const elapsed = formatElapsed(task);
  const progress =
    task.state === "done" || task.state === "reviewing" ? 1 :
    task.state === "running" || task.state === "failed" ? 0.5 : 0;
  return (
    <div className="td-card">
      <div className="td-card__head">
        <span className="td-card__head-label">当前活动</span>
        <span className="td-card__head-time">{elapsed ?? "—"}</span>
      </div>
      <div className="td-card__activity">
        {task.needsInputWhat ?? STATE_LABEL_DRAWER[task.state]}
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
        <Metric label="状态">{STATE_LABEL_DRAWER[task.state]}</Metric>
        <Metric label="重试" tone={task.retries > 0 ? "warn" : "muted"}>{task.retries} / {task.maxRetries}</Metric>
        <Metric label="尝试">#{task.retries + 1}</Metric>
      </div>
    </div>
  );
}

const STATE_LABEL_DRAWER: Record<TaskState, string> = {
  queued:        "排队中",
  running:       "进行中",
  "needs-input": "等待输入",
  reviewing:     "待 review",
  done:          "已完成",
  failed:        "失败",
  cancelled:     "已取消",
};

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
  const actions: { label: string; tone?: "primary" | "danger" | "ghost"; icon?: React.ReactNode; onClick?: () => void }[] = [];

  if (task.state === "queued") {
    actions.push({ label: "取消", tone: "ghost", icon: Icon.x, onClick: () => { void onCancel(); } });
  } else if (task.state === "running") {
    actions.push({ label: "中止", tone: "danger", icon: Icon.x, onClick: () => { void onCancel(); } });
  } else if (task.state === "reviewing") {
    actions.push({ label: "批准并合并", tone: "primary", icon: Icon.check, onClick: () => { void onAccept(); } });
    actions.push({ label: "拒绝并清理",                  icon: Icon.x,     onClick: () => { void onReject(); } });
    actions.push({ label: "重新跑",                       icon: Icon.refresh, onClick: () => { void onRetry(); } });
  } else if (task.state === "failed") {
    actions.push({ label: "重新跑", tone: "primary", icon: Icon.refresh, onClick: () => { void onRetry(); } });
    actions.push({ label: "取消任务", tone: "ghost", icon: Icon.x, onClick: () => { void onCancel(); } });
  } else if (task.state === "done") {
    actions.push({ label: "再跑一次", icon: Icon.refresh, onClick: () => { void onRetry(); } });
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
  const { messages, events, loading } = useThreadStream(api, threadId);
  const { rows } = buildTimeline(messages, events);
  if (rows.length === 0) {
    return (
      <section className="td-thread">
        <div className="td-thread__body">
          {loading
            ? <LoadingRows rows={3} compact />
            : <div className="td-thread__empty">runner 还没说话…</div>}
        </div>
      </section>
    );
  }
  return (
    <section className="td-thread">
      <div className="td-thread__head">
        <span>{rows.length} 条消息</span>
      </div>
      <div className="td-thread__body">
        {rows.map((row) => {
          if (row.kind === "user") return <UserMessage key={row.key} text={row.text} attachments={row.attachments} />;
          if (row.kind === "system") {
            return (
              <div key={row.key} className="msg msg--aux">
                <div className="td-thread__system"><Markdown text={row.text} /></div>
              </div>
            );
          }
          if (row.kind === "assistant-text") return <AssistantText key={row.key} text={row.text} />;
          return (
            <AssistantBlocks
              key={row.key}
              blocks={row.blocks}
              streaming={row.streaming}
              errorClassName="td-thread__error"
            />
          );
        })}
      </div>
    </section>
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
