/**
 * NewTask — modal for filing a task inside a project.
 *
 * (Shared component lifted from apps/desktop/src/NewTask.tsx; same three
 * tabs: 手动 / 从 Linear 拉 / 上传 backlog. The Linear + upload tabs remain
 * UI-only — the SP-3 backend treats every task creation as "manual" and
 * the cloud route only persists `title` / `description` / `priority` /
 * `labels`. The full draft is still surfaced via `onCreate` so the host
 * UI can preserve user intent in the future.)
 *
 * Submit returns the draft via onCreate. The host (Shell/App) is expected
 * to call `useProjectBoard().createTask(...)` for each filed task; the
 * board's WS subscription paints the new cards.
 */
import { useState } from "react";
import { Icon } from "../icons.js";
import "./new-task.css";

type Tab = "manual" | "linear" | "upload";

type LinearIssue = { id: string; ref: string; title: string };
// Placeholder content — Linear OAuth is SP-3+1. Keeps the visual demo identical.
const MOCK_LINEAR_ISSUES: LinearIssue[] = [
  { id: "li1", ref: "COG-130", title: "Sync engine: reconnect with lastSeq replay" },
  { id: "li2", ref: "COG-131", title: "Sidebar: project mode list view" },
  { id: "li3", ref: "COG-132", title: "Settings: device revocation API" },
  { id: "li4", ref: "COG-133", title: "Multi-host fallback inline card" },
  { id: "li5", ref: "COG-134", title: "Magic-link email templating" },
  { id: "li6", ref: "BUG-32",  title: "Drafts vanish on disconnect" },
];

export type NewTaskDraft =
  | { kind: "manual"; title: string; description: string }
  | { kind: "linear"; team: string; issueIds: string[] }
  | { kind: "upload"; file: File };

export function NewTask({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate?: (draft: NewTaskDraft) => void | Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("manual");

  // manual
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // linear
  const [team, setTeam] = useState("COG");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // upload
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const canSubmit =
    tab === "manual" ? title.trim().length > 0 :
    tab === "linear" ? picked.size > 0 :
    tab === "upload" ? file !== null :
    false;

  const submit = () => {
    if (!canSubmit) return;
    if (tab === "manual") void onCreate?.({ kind: "manual", title, description });
    if (tab === "linear") void onCreate?.({ kind: "linear", team, issueIds: Array.from(picked) });
    if (tab === "upload" && file) void onCreate?.({ kind: "upload", file });
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

        <nav className="nt__tabs">
          <button className={"nt__tab" + (tab === "manual" ? " is-on" : "")} onClick={() => setTab("manual")}>{Icon.edit} 手动</button>
          <button className={"nt__tab" + (tab === "linear" ? " is-on" : "")} onClick={() => setTab("linear")}>{Icon.link} 从 Linear 拉</button>
          <button className={"nt__tab" + (tab === "upload" ? " is-on" : "")} onClick={() => setTab("upload")}>{Icon.attach} 上传 backlog</button>
        </nav>

        <div className="modal__body">
          {tab === "manual" && (
            <>
              <div className="field">
                <div className="field__label">标题<span className="field__required">*</span></div>
                <input className="input" placeholder="一句话说明这次要做什么" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
              </div>
              <div className="field">
                <div className="field__label">描述</div>
                <textarea className="input nt__textarea" placeholder="补充上下文、约束、验收标准" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} />
                <div className="field__hint">描述会作为任务的初始 user message 注入对话。</div>
              </div>
            </>
          )}

          {tab === "linear" && (
            <>
              <div className="field">
                <div className="field__label">Team</div>
                <select className="input" value={team} onChange={(e) => setTeam(e.target.value)}>
                  <option value="COG">COG · Cogni Core</option>
                  <option value="BUG">BUG · 线上修复</option>
                  <option value="DOC">DOC · 文档自动化</option>
                </select>
              </div>
              <div className="field">
                <div className="field__label">勾选要拉的 issue<span className="field__required">*</span></div>
                <ul className="nt__issues">
                  {MOCK_LINEAR_ISSUES.filter((i) => i.ref.startsWith(team)).map((i) => {
                    const on = picked.has(i.id);
                    return (
                      <li key={i.id}>
                        <label className={"nt__issue" + (on ? " is-on" : "")}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => {
                              const next = new Set(picked);
                              if (e.target.checked) next.add(i.id); else next.delete(i.id);
                              setPicked(next);
                            }}
                          />
                          <span className="nt__issue-ref">{i.ref}</span>
                          <span className="nt__issue-title">{i.title}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="field__hint">{picked.size === 0 ? "至少选一个" : `已选 ${picked.size} 个`}</div>
              </div>
            </>
          )}

          {tab === "upload" && (
            <div className="field">
              <div className="field__label">把 backlog 文件拖到这里<span className="field__required">*</span></div>
              <label
                className={"nt__drop" + (dragOver ? " is-over" : "") + (file ? " is-set" : "")}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files[0];
                  if (f) setFile(f);
                }}
              >
                <input
                  type="file"
                  accept=".md,.csv,.txt"
                  style={{ display: "none" }}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {file ? (
                  <div className="nt__drop-set">
                    <span className="nt__drop-icon">{Icon.file}</span>
                    <div className="nt__drop-name">{file.name}</div>
                    <div className="nt__drop-meta">{(file.size / 1024).toFixed(1)} KB</div>
                    <button className="btn btn-sm btn-ghost" onClick={(e) => { e.preventDefault(); setFile(null); }}>{Icon.x} 换一个</button>
                  </div>
                ) : (
                  <>
                    <span className="nt__drop-icon">{Icon.attach}</span>
                    <div className="nt__drop-prompt">
                      拖入文件,或 <span className="nt__drop-link">点击选择</span>
                    </div>
                    <div className="nt__drop-types">.md  ·  .csv  ·  .txt  ·  最多 1 MB</div>
                  </>
                )}
              </label>
              <div className="field__hint">每一行 / 每一段 = 一个任务,Cogni 会自动断句生成 ref 和标题。</div>
            </div>
          )}
        </div>

        <footer className="modal__foot">
          <button className="btn btn-sm" onClick={onClose}>取消</button>
          <button className="btn btn-sm btn-primary" disabled={!canSubmit} onClick={submit}>
            {Icon.plus}{tab === "linear" ? ` 创建 ${picked.size} 个任务` : tab === "upload" ? " 导入" : " 创建任务"}
          </button>
        </footer>
      </div>
    </div>
  );
}
