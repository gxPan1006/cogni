/**
 * TaskDetail — right-side drawer for one task.
 *
 * Why a drawer (not modal/route):
 *   - Keeps the kanban / list visible behind a scrim → multitasking context preserved
 *   - ←/→ arrow keys cycle to adjacent tasks in `allTaskIds` without losing place
 *   - Esc closes; clicking the scrim closes
 *   - Mirrors the chat thread detail form (same width, same shadow language)
 *
 * Content order (top → bottom):
 *   1. Header: ref, title, state pill, host, close
 *   2. Status stepper (queued → running → needs-input → reviewing → done)
 *   3. Activity card: current activity + progress + retries + delta
 *   4. Action row: state-dependent buttons (approve / restart / etc)
 *   5. needs-input prompt: highlighted block surfacing what's blocked
 *   6. Embedded chat: full ChatBlocks render of the linked thread (mock data
 *      for now; swap for real fetch when wired)
 *
 * The drawer renders the underlying message stream via the existing ChatBlocks —
 * imported from `@cogni/ui` (the package the migration target lives in). If
 * you're still in apps/desktop, change the import to `"./ChatBlocks.js"`.
 */
import { useEffect } from "react";
import { Icon, UserMessage, AssistantText, ThinkingBlock, ToolCallBlock } from "@cogni/ui";
import { StatePill, Delta } from "./Project.js";
import {
  MOCK_HOSTS, MOCK_PROJECTS, MOCK_TASK_THREADS,
  type DesignTask, type MockThreadMessage,
} from "./mock.js";
import "./task-detail.css";

const STEPPER: { state: DesignTask["state"]; label: string }[] = [
  { state: "queued",      label: "排队中" },
  { state: "running",     label: "进行中" },
  { state: "needs-input", label: "等待输入" },
  { state: "reviewing",   label: "Review" },
  { state: "done",        label: "完成" },
];

export function TaskDetail({
  task,
  allTaskIds,
  onClose,
  onNavigate,
}: {
  task: DesignTask;
  allTaskIds?: string[];
  onClose: () => void;
  onNavigate?: (id: string) => void;
}) {
  // Keyboard: Esc / ← / →
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (!allTaskIds || !onNavigate) return;
      const idx = allTaskIds.indexOf(task.id);
      if (idx < 0) return;
      if (e.key === "ArrowLeft"  && idx > 0)                       onNavigate(allTaskIds[idx - 1]);
      if (e.key === "ArrowRight" && idx < allTaskIds.length - 1)  onNavigate(allTaskIds[idx + 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task.id, allTaskIds, onClose, onNavigate]);

  const host    = MOCK_HOSTS.find((h) => h.id === task.hostId);
  const project = MOCK_PROJECTS.find((p) => p.id === task.projectId);
  const thread  = task.threadId ? MOCK_TASK_THREADS[task.threadId] : undefined;
  const idx     = allTaskIds?.indexOf(task.id) ?? -1;
  const total   = allTaskIds?.length ?? 0;

  return (
    <>
      <div className="td-scrim" onClick={onClose} />
      <aside className="td" role="dialog" aria-label={`Task ${task.ref}`}>
        <header className="td__head">
          <div className="td__head-nav">
            <button className="td__icon-btn" onClick={onClose} title="关闭 (Esc)">{Icon.x}</button>
            {allTaskIds && total > 1 && (
              <div className="td__pager">
                <button
                  className="td__icon-btn"
                  disabled={idx <= 0}
                  onClick={() => idx > 0 && onNavigate?.(allTaskIds[idx - 1])}
                  title="上一个任务 (←)"
                >
                  <span style={{ transform: "rotate(180deg)", display: "inline-flex" }}>{Icon.arrow}</span>
                </button>
                <span className="td__pager-count">{idx + 1} / {total}</span>
                <button
                  className="td__icon-btn"
                  disabled={idx >= total - 1}
                  onClick={() => idx < total - 1 && onNavigate?.(allTaskIds[idx + 1])}
                  title="下一个任务 (→)"
                >
                  {Icon.arrow}
                </button>
              </div>
            )}
          </div>
          <div className="td__head-body">
            <div className="td__head-meta">
              <span className="td__ref">{task.ref}</span>
              <span className="td__sep">·</span>
              <span className="td__project">{project?.name ?? task.projectId}</span>
            </div>
            <h2 className="td__title">{task.title}</h2>
            <div className="td__head-row">
              <StatePill state={task.state} />
              {host && (
                <span className="td__host">
                  <span className={"dot " + (host.status === "online" ? "dot-online" : "dot-offline")} />
                  <span>{host.name}</span>
                </span>
              )}
              {task.startedAt && <span className="td__started">started {task.startedAt}</span>}
            </div>
          </div>
        </header>

        <div className="td__scroll">
          <Stepper currentState={task.state} />

          <ActivityCard task={task} />

          {task.state === "needs-input" && task.needsInput && (
            <div className="td-needs">
              <div className="td-needs__head">
                <span className="td-needs__icon">{Icon.shield}</span>
                <span className="td-needs__label">等你回应</span>
              </div>
              <div className="td-needs__body">{task.needsInput.what}</div>
              <div className="td-needs__actions">
                <button className="btn btn-sm">拒绝</button>
                <button className="btn btn-sm btn-primary">同意一次</button>
                <button className="btn btn-sm btn-ghost">本任务一直允许</button>
              </div>
            </div>
          )}

          <Actions task={task} />

          {thread && thread.length > 0 && (
            <section className="td-thread">
              <div className="td-thread__head">
                <span>对话 · {thread.length} 条</span>
                <button className="btn btn-sm btn-ghost">{Icon.link} 在 Chat 中打开</button>
              </div>
              <div className="td-thread__body">
                {thread.map((m) => <ThreadMessage key={m.id} message={m} />)}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

/* ─── Subcomponents ──────────────────────────────────── */

function Stepper({ currentState }: { currentState: DesignTask["state"] }) {
  // failed state: render as stepper but reveal a "failed" indicator on the
  // step where it failed (we treat it as living at the "running" position).
  const isFailed = currentState === "failed";
  const effective = isFailed ? "running" : currentState;
  const currentIdx = STEPPER.findIndex((s) => s.state === effective);

  return (
    <ol className="td-stepper">
      {STEPPER.map((s, i) => {
        const cls = "td-stepper__step"
          + (i < currentIdx  ? " td-stepper__step--past"    : "")
          + (i === currentIdx ? " td-stepper__step--current" : "")
          + (isFailed && i === currentIdx ? " td-stepper__step--failed" : "");
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

function ActivityCard({ task }: { task: DesignTask }) {
  return (
    <div className="td-card">
      <div className="td-card__head">
        <span className="td-card__head-label">当前活动</span>
        <span className="td-card__head-time">{task.elapsed}</span>
      </div>
      <div className="td-card__activity">{task.activity}</div>
      {(task.state === "running" || task.state === "reviewing" || task.state === "failed") && (
        <div className="kb-progress td-card__progress">
          <div className="kb-progress__fill" style={{
            width: `${task.progress * 100}%`,
            background: task.state === "failed" ? "var(--bad)" : "var(--accent)",
          }} />
        </div>
      )}
      <div className="td-card__metrics">
        <Metric label="进度">{Math.round(task.progress * 100)}%</Metric>
        <Metric label="重试" tone={task.retries > 0 ? "warn" : "muted"}>{task.retries}</Metric>
        <Metric label="diff"><Delta delta={task.delta} /></Metric>
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

function Actions({ task }: { task: DesignTask }) {
  // Action set depends on the task's state. We rely on convention rather than a
  // big switch — fewer code paths, easier to extend.
  const actions: { label: string; tone?: "primary" | "danger" | "ghost"; icon?: React.ReactNode }[] = [];

  if (task.state === "queued") {
    actions.push({ label: "提到队首", tone: "primary", icon: Icon.bolt });
    actions.push({ label: "取消", tone: "ghost", icon: Icon.x });
  } else if (task.state === "running") {
    actions.push({ label: "暂停", icon: Icon.spark });
    actions.push({ label: "中止", tone: "danger", icon: Icon.x });
  } else if (task.state === "reviewing") {
    actions.push({ label: "批准并合并", tone: "primary", icon: Icon.check });
    actions.push({ label: "请重试", icon: Icon.refresh });
    actions.push({ label: "升级到人工", tone: "ghost", icon: Icon.user });
  } else if (task.state === "failed") {
    actions.push({ label: "重新跑", tone: "primary", icon: Icon.refresh });
    actions.push({ label: "复制错误日志", icon: Icon.attach });
    actions.push({ label: "标记为放弃", tone: "ghost" });
  } else if (task.state === "done") {
    actions.push({ label: "看 PR", icon: Icon.link });
    actions.push({ label: "再跑一次", icon: Icon.refresh });
  }
  // needs-input has its own action block above (the td-needs block)

  if (actions.length === 0) return null;
  return (
    <div className="td-actions">
      {actions.map((a, i) => (
        <button
          key={i}
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

function ThreadMessage({ message }: { message: MockThreadMessage }) {
  if (message.role === "user")      return <UserMessage text={message.content} />;
  if (message.role === "assistant") return <AssistantText text={message.content} />;
  if (message.role === "thinking")  return <ThinkingBlock text={message.content} />;
  if (message.role === "tool")      return <ToolCallBlock name={message.toolName ?? ""} input={message.toolInput} result={message.toolResult} status={message.toolStatus ?? "done"} />;
  if (message.role === "system")    return <div className="td-thread__system">{message.content}</div>;
  return null;
}
