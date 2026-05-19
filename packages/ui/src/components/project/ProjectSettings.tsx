/**
 * ProjectSettings — per-project settings page.
 *
 * (Shared component lifted from apps/desktop/src/ProjectSettings.tsx. Same
 * left-rail + right-body shape, same five sections. Two real changes vs the
 * mock-driven version:)
 *
 *   1. `project` + `hosts` come from props (Shell uses `useProjectBoard` to
 *      fetch the project; web uses the same hook).
 *   2. Save / archive callbacks are wired:
 *        - basics / prompt / runner save → `onUpdate(patch)` (the Shell calls
 *          `api.updateProject(id, patch)` then refreshes via WS push)
 *        - danger archive → `onArchive()` (Shell calls `api.archiveProject`).
 *
 * The "source" picker is preserved visually (Linear / 内部 / 手动) but its
 * value is **not** persisted to the cloud — SP-3 contract has no source
 * field. The Linear OAuth wire-up lands in SP-3+1.
 *
 * "删除项目" is left as a UI-only step in SP-3: archive is the supported
 * lifecycle. The button looks the same but routes to `onArchive` rather
 * than a separate delete endpoint.
 */
import { useEffect, useState } from "react";
import type { Project, MergePolicy } from "@cogni/contract";
import type { HostInfo, UpdateProjectInput } from "../../transport/api.js";
import { Icon } from "../icons.js";
import "./project-settings.css";

type Section = "basics" | "source" | "runner" | "prompt" | "danger";

export function ProjectSettings({
  project,
  hosts,
  onClose,
  onUpdate,
  onArchive,
}: {
  project: Project | null;
  hosts: HostInfo[];
  onClose: () => void;
  onUpdate?: (patch: UpdateProjectInput) => Promise<void> | void;
  onArchive?: () => Promise<void> | void;
}) {
  const [section, setSection] = useState<Section>("basics");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hostId, setHostId] = useState("");
  const [concurrency, setConcurrency] = useState(2);
  const [prompt, setPrompt] = useState("");
  const [mergePolicy, setMergePolicy] = useState<MergePolicy>("require-review");
  const [confirmArchive, setConfirmArchive] = useState(false);

  // Rehydrate form state when the project row updates (e.g. WS push from
  // another tab saved a change).
  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setDescription(project.description ?? "");
    setHostId(project.defaultHostId);
    setConcurrency(project.concurrencyLimit);
    setPrompt(project.systemPrompt ?? "");
    setMergePolicy(project.mergePolicy);
  }, [project]);

  if (!project) {
    return (
      <div className="ps">
        <main className="ps__body">
          <Section title="加载中…" subtitle=""><div /></Section>
        </main>
      </div>
    );
  }

  const saveBasics = () =>
    void onUpdate?.({ name, description: description || null });
  const saveRunner = () =>
    void onUpdate?.({ defaultHostId: hostId, concurrencyLimit: concurrency, mergePolicy });
  const savePrompt = () =>
    void onUpdate?.({ systemPrompt: prompt || null });

  return (
    <div className="ps">
      <aside className="ps__nav">
        <div className="ps__nav-head">
          <button className="ps__icon-btn" onClick={onClose} title="返回">{Icon.x}</button>
          <div className="ps__nav-text">
            <div className="ps__nav-eyebrow">PROJECT SETTINGS</div>
            <div className="ps__nav-name">{project.name}</div>
          </div>
        </div>
        <nav className="ps__menu">
          <NavBtn id="basics"  active={section} onClick={setSection} icon={Icon.edit}>基础</NavBtn>
          <NavBtn id="source"  active={section} onClick={setSection} icon={Icon.flow}>任务来源</NavBtn>
          <NavBtn id="runner"  active={section} onClick={setSection} icon={Icon.bolt}>Runner</NavBtn>
          <NavBtn id="prompt"  active={section} onClick={setSection} icon={Icon.brain}>System prompt</NavBtn>
          <NavBtn id="danger"  active={section} onClick={setSection} icon={Icon.trash} danger>危险区</NavBtn>
        </nav>
      </aside>

      <main className="ps__body">
        {section === "basics" && (
          <Section title="基础" subtitle="项目最基本的几样东西。">
            <div className="settings-card">
              <div className="ps__field">
                <div className="field__label">名字</div>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="ps__field">
                <div className="field__label">描述</div>
                <textarea className="input ps__textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
              </div>
              <SaveBar onSave={saveBasics} />
            </div>
          </Section>
        )}

        {section === "source" && (
          <Section title="任务来源" subtitle="SP-3 中保留为 UI 占位,实际任务源在 SP-3+1 接通 Linear。">
            <div className="settings-card">
              <div className="ps__field">
                <div className="seg seg--block">
                  <button className={"seg__btn"} disabled>Linear</button>
                  <button className={"seg__btn is-on"}>内部 tracker</button>
                  <button className={"seg__btn"} disabled>手动</button>
                </div>
                <div className="ps__hint">当前所有任务都视为内部 tracker。SP-3+1 接 Linear 后,这里会有真切换。</div>
              </div>
            </div>
          </Section>
        )}

        {section === "runner" && (
          <Section title="Runner" subtitle="任务跑在哪儿、跑多少、合并怎么把关。">
            <div className="settings-card">
              <div className="ps__field">
                <div className="field__label">默认 host</div>
                <select className="input" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}{h.status === "offline" ? " · 离线" : ""}
                    </option>
                  ))}
                </select>
                <div className="field__hint">新任务首先尝试在这台机器上跑。离线时按 SP-2 fallback 流程切换。</div>
              </div>
              <div className="ps__field">
                <div className="field__label">合并策略</div>
                <select className="input" value={mergePolicy} onChange={(e) => setMergePolicy(e.target.value as MergePolicy)}>
                  <option value="require-review">require-review</option>
                  <option value="auto-merge">auto-merge</option>
                  <option value="auto-merge-if-tests-pass">auto-merge-if-tests-pass</option>
                </select>
              </div>
              <div className="ps__field">
                <div className="field__label">并发上限</div>
                <div className="np__stepper">
                  <button className="btn btn-sm btn-ghost" onClick={() => setConcurrency(Math.max(1, concurrency - 1))} disabled={concurrency <= 1}>−</button>
                  <div className="np__stepper-value">{concurrency}</div>
                  <button className="btn btn-sm btn-ghost" onClick={() => setConcurrency(Math.min(16, concurrency + 1))} disabled={concurrency >= 16}>+</button>
                </div>
                <div className="field__hint">超过的任务自动进队列,等空位。</div>
              </div>
              <SaveBar onSave={saveRunner} />
            </div>
          </Section>
        )}

        {section === "prompt" && (
          <Section title="System prompt" subtitle="注入每个任务对话的开头。改完只影响新建任务。">
            <div className="settings-card">
              <div className="ps__field">
                <textarea className="input ps__textarea ps__textarea--lg" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例:你是这个项目的高级开发,熟悉 TS。优先写测试。" rows={8} />
                <div className="field__hint">{prompt.length} 字 · 一般保持 200 字以内。</div>
              </div>
              <SaveBar onSave={savePrompt} />
            </div>
          </Section>
        )}

        {section === "danger" && (
          <Section title="危险区" subtitle="不可逆操作。三思后再点。">
            <div className="settings-card ps__danger-card">
              <div className="ps__danger-row">
                <div>
                  <div className="ps__danger-title">归档项目</div>
                  <div className="ps__danger-sub">项目从列表上消失,任务停止排队,已跑的历史保留。</div>
                </div>
                {confirmArchive ? (
                  <div className="ps__danger-confirm">
                    <span>确定?</span>
                    <button className="btn btn-sm" onClick={() => setConfirmArchive(false)}>取消</button>
                    <button className="btn btn-sm ps__danger-delete" onClick={() => { void onArchive?.(); setConfirmArchive(false); }}>归档</button>
                  </div>
                ) : (
                  <button className="btn btn-sm" onClick={() => setConfirmArchive(true)}>归档</button>
                )}
              </div>
              <div className="ps__danger-row">
                <div>
                  <div className="ps__danger-title">删除项目</div>
                  <div className="ps__danger-sub">SP-3 中"删除"等价归档(走同一条路径)。硬删要等 SP-4 的 retention policy。</div>
                </div>
                <button className="btn btn-sm ps__danger-delete" disabled title="SP-3 用归档代替">
                  {Icon.trash} 不可用
                </button>
              </div>
            </div>
          </Section>
        )}
      </main>
    </div>
  );
}

function NavBtn({
  id, active, onClick, icon, children, danger,
}: {
  id: Section;
  active: Section;
  onClick: (id: Section) => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      className={"ps__menu-item" + (active === id ? " is-on" : "") + (danger ? " ps__menu-item--danger" : "")}
      onClick={() => onClick(id)}
    >
      <span className="ps__menu-icon">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <>
      <div className="ps__section-head">
        <div className="ps__section-title">{title}</div>
        {subtitle && <div className="ps__section-sub">{subtitle}</div>}
      </div>
      {children}
    </>
  );
}

function SaveBar({ onSave }: { onSave?: () => void }) {
  return (
    <div className="ps__save">
      <span className="ps__save-hint">改完点保存</span>
      <button className="btn btn-sm btn-primary" onClick={onSave}>保存</button>
    </div>
  );
}
