/**
 * NewProject — modal for creating a project.
 *
 * Single-step (not wizard). Required: name. Everything else has a sensible default.
 * The Backlog source picker is a 3-way segment; Linear shows a teamId input +
 * "Test connection" button (placeholder — no real API call yet).
 *
 * Submit returns the draft via onCreate. The host (Shell) is expected to
 * POST /projects, then close the modal and navigate into the new project.
 */
import { useState } from "react";
import { Icon } from "@cogni/ui";
import { MOCK_HOSTS } from "./mock.js";
import "./new-project.css";

type SourceKind = "linear" | "internal" | "manual";

export type NewProjectDraft = {
  name: string;
  description: string;
  source: SourceKind;
  linearTeamId?: string;
  defaultHostId: string;
  concurrencyLimit: number;
  systemPrompt: string;
};

export function NewProject({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate?: (draft: NewProjectDraft) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<SourceKind>("manual");
  const [linearTeamId, setLinearTeamId] = useState("");
  const [defaultHostId, setDefaultHostId] = useState(MOCK_HOSTS[0]?.id ?? "");
  const [concurrencyLimit, setConcurrencyLimit] = useState(2);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [testing, setTesting] = useState<"idle" | "testing" | "ok" | "fail">("idle");

  const canSubmit = name.trim().length > 0 && (source !== "linear" || linearTeamId.trim().length > 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal np" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <div>
            <div className="modal__eyebrow">新建</div>
            <h2 className="modal__title">新项目</h2>
          </div>
          <button className="modal__close" onClick={onClose} title="关闭 (Esc)">{Icon.x}</button>
        </header>

        <div className="modal__body">
          <Field label="名字" required hint="一句话能说出这个项目做什么">
            <input className="input" placeholder="例:SP-2 多端同步" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>

          <Field label="描述" hint="可选">
            <textarea className="input np__textarea" placeholder="给一两句话上下文,会进 system prompt" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>

          <Field label="任务来源">
            <div className="seg seg--block">
              <button className={"seg__btn" + (source === "linear"   ? " is-on" : "")} onClick={() => setSource("linear")}>Linear</button>
              <button className={"seg__btn" + (source === "internal" ? " is-on" : "")} onClick={() => setSource("internal")}>内部 tracker</button>
              <button className={"seg__btn" + (source === "manual"   ? " is-on" : "")} onClick={() => setSource("manual")}>手动</button>
            </div>
            {source === "linear" && (
              <div className="np__linear">
                <input
                  className="input np__linear-input"
                  placeholder="Linear team ID(例:COG)"
                  value={linearTeamId}
                  onChange={(e) => { setLinearTeamId(e.target.value); setTesting("idle"); }}
                />
                <button
                  className="btn btn-sm"
                  disabled={!linearTeamId.trim() || testing === "testing"}
                  onClick={() => {
                    setTesting("testing");
                    setTimeout(() => setTesting(linearTeamId.toUpperCase() === "FAIL" ? "fail" : "ok"), 700);
                  }}
                >
                  {testing === "testing" ? "测试中…" : "测试连接"}
                </button>
              </div>
            )}
            {source === "linear" && testing === "ok"   && <div className="np__test np__test--ok">连接成功 · 找到 {Math.floor(Math.random() * 30) + 4} 个 active issues</div>}
            {source === "linear" && testing === "fail" && <div className="np__test np__test--fail">连接失败 · 检查 team ID 和 API key</div>}
            {source === "internal" && <div className="np__hint">用 Cogni 内置的 tracker,无需外部账号。</div>}
            {source === "manual"   && <div className="np__hint">所有任务由你或 agent 自己加。</div>}
          </Field>

          <div className="np__row">
            <Field label="默认 host" hint="新任务首先尝试在这台机器上跑">
              <select className="input" value={defaultHostId} onChange={(e) => setDefaultHostId(e.target.value)}>
                {MOCK_HOSTS.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}{h.status === "offline" ? " · 离线" : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="并发上限" hint="最多同时几个 runner">
              <div className="np__stepper">
                <button className="btn btn-sm btn-ghost" onClick={() => setConcurrencyLimit(Math.max(1, concurrencyLimit - 1))} disabled={concurrencyLimit <= 1}>−</button>
                <div className="np__stepper-value">{concurrencyLimit}</div>
                <button className="btn btn-sm btn-ghost" onClick={() => setConcurrencyLimit(Math.min(16, concurrencyLimit + 1))} disabled={concurrencyLimit >= 16}>+</button>
              </div>
            </Field>
          </div>

          <Field label="System prompt" hint="可选,会注入每个任务的对话开头">
            <textarea className="input np__textarea" placeholder="例:你是这个项目的高级开发,熟悉 TS。优先写测试。" rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </Field>
        </div>

        <footer className="modal__foot">
          <button className="btn btn-sm" onClick={onClose}>取消</button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!canSubmit}
            onClick={() => onCreate?.({ name, description, source, linearTeamId: source === "linear" ? linearTeamId : undefined, defaultHostId, concurrencyLimit, systemPrompt })}
          >
            {Icon.plus} 创建项目
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field__label">
        {label}
        {required && <span className="field__required">*</span>}
      </div>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}
