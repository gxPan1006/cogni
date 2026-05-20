/**
 * TaskComments — the 主页面 comment feed card grid.
 *
 * Worker handoff cards (sparkle icon + a state chip like "→ 完成") and human
 * comment cards (user icon + a delete affordance on own un-consumed cards)
 * wrap in a CSS grid, chronological. A trailing dashed "+" card opens an
 * inline composer; submitting appends a human card (inert server-side, lands
 * via the WS echo). The empty state shows just the "+" card with hint text.
 */
import { useState } from "react";
import type { TaskComment } from "@cogni/contract";
import type { ApiClient } from "../../transport/api.js";
import { useTaskComments } from "../../hooks/useTaskComments.js";
import { Composer } from "../Composer.js";
import { Markdown } from "../Markdown.js";
import { Icon } from "../icons.js";
import { STATE_COLOR } from "./ProjectBoard.js";

const STATE_CHIP: Record<string, string> = {
  done: "→ 完成",
  reviewing: "→ 待 Review",
  "needs-input": "→ 等待输入",
  running: "→ 进行中",
  queued: "→ 排队中",
  failed: "→ 失败",
  cancelled: "→ 已取消",
};

export function TaskComments({ api, taskId }: { api: ApiClient; taskId: string }) {
  const { comments, loading, add, remove } = useTaskComments(api, taskId);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setAdding(false);
    void add(text);
  };

  return (
    <section className="tc">
      <div className="tc__head">评论 · 交接说明</div>
      <div className="tc__grid">
        {comments.map((c) => (
          <CommentCard key={c.id} comment={c} onDelete={() => void remove(c.id)} />
        ))}
        {adding ? (
          <div className="tc__card tc__card--compose">
            <Composer
              draft={draft}
              setDraft={setDraft}
              onSubmit={submit}
              placeholder="写条说明,给下一次运行…"
            />
          </div>
        ) : (
          <button className="tc__card tc__card--add" onClick={() => setAdding(true)}>
            <span className="tc__add-plus">{Icon.plus}</span>
            <span className="tc__add-hint">
              {comments.length === 0 && !loading ? "给下一次运行留点说明…" : "新增评论"}
            </span>
          </button>
        )}
      </div>
    </section>
  );
}

function CommentCard({ comment, onDelete }: { comment: TaskComment; onDelete: () => void }) {
  const isWorker = comment.author === "worker";
  return (
    <div className={"tc__card" + (isWorker ? " tc__card--worker" : " tc__card--user")}>
      <div className="tc__card-head">
        <span className="tc__avatar">{isWorker ? Icon.spark : Icon.user}</span>
        {isWorker && (
          <span className="tc__chip" style={{ color: STATE_COLOR[comment.state] }}>
            {STATE_CHIP[comment.state] ?? comment.state}
          </span>
        )}
        {!isWorker && comment.consumedByRunId && <span className="tc__badge">已交给 worker</span>}
        {!isWorker && !comment.consumedByRunId && (
          <button className="tc__del" title="删除" onClick={onDelete}>{Icon.x}</button>
        )}
      </div>
      <div className="tc__card-body"><Markdown text={comment.body} /></div>
      <time className="tc__time">{formatAgo(comment.createdAt)}</time>
    </div>
  );
}

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
