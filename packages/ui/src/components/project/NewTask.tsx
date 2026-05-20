/**
 * NewTask — modal for filing a task inside a project.
 *
 * (Shared component lifted from apps/desktop/src/NewTask.tsx.)
 *
 * Cogni treats a task as a direct instruction to a supervised runner. External
 * tracker imports are intentionally kept outside this surface.
 */
import { useState } from "react";
import { Icon } from "../icons.js";
import "./new-task.css";

export type NewTaskDraft = { title: string; description: string };

export function NewTask({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate?: (draft: NewTaskDraft) => void | Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const canSubmit = title.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    void onCreate?.({ title, description });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal nt" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <div>
            <div className="modal__eyebrow">新建</div>
            <h2 className="modal__title">新任务</h2>
          </div>
          <button className="modal__close" onClick={onClose} title="关闭 (Esc)">{Icon.x}</button>
        </header>

        <div className="modal__body">
          <div className="field">
            <div className="field__label">标题<span className="field__required">*</span></div>
            <input className="input" placeholder="一句话说明这次要做什么" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <div className="field__label">描述</div>
            <textarea className="input nt__textarea" placeholder="补充上下文、约束、验收标准" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} />
            <div className="field__hint">描述会作为任务的初始 user message 注入对话。</div>
          </div>
        </div>

        <footer className="modal__foot">
          <button className="btn btn-sm" onClick={onClose}>取消</button>
          <button className="btn btn-sm btn-primary" disabled={!canSubmit} onClick={submit}>
            {Icon.plus} 创建任务
          </button>
        </footer>
      </div>
    </div>
  );
}
