/**
 * ProjectSettings — per-project settings page.
 *
 * Shape mirrors the global Settings (left nav + right body) so muscle memory
 * carries over. Sections:
 *   - 基础         name + description
 *   - 任务来源      Backlog source — same picker as NewProject
 *   - Runner       默认 host + 并发上限
 *   - System prompt 大 textarea
 *   - 危险区        archive / delete (二次确认)
 *
 * No real API — every section logs to console. Wire up when SP-3 lands.
 */
import { useState } from "react";
import { Icon } from "@cogni/ui";
import { MOCK_HOSTS, MOCK_PROJECTS } from "./mock.js";
import "./project-settings.css";

type Section = "basics" | "source" | "runner" | "prompt" | "danger";

export function ProjectSettings({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const project = MOCK_PROJECTS.find((p) => p.id === projectId) ?? MOCK_PROJECTS[0];

  const [section, setSection] = useState<Section>("basics");
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [source, setSource] = useState(project.source?.kind ?? "manual");
  const [hostId, setHostId] = useState(project.defaultHostId ?? MOCK_HOSTS[0]?.id ?? "");
  const [concurrency, setConcurrency] = useState(project.concurrencyLimit ?? 2);
  const [prompt, setPrompt] = useState(project.systemPrompt ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

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
              <SaveBar />
            </div>
          </Section>
        )}

        {section === "source" && (
          <Section title="任务来源" subtitle="切换来源会重新对接,正在跑的任务不受影响。">
            <div className="settings-card">
              <div className="ps__field">
                <div className="seg seg--block">
                  <button className={"seg__btn" + (source === "linear"   ? " is-on" : "")} onClick={() => setSource("linear")}>Linear</button>
                  <button className={"seg__btn" + (source === "internal" ? " is-on" : "")} onClick={() => setSource("internal")}>内部 tracker</button>
                  <button className={"seg__btn" + (source === "manual"   ? " is-on" : "")} onClick={() => setSource("manual")}>手动</button>
                </div>
                {source === "linear" && (
                  <div className="ps__hint">
                    Linear team ID:<code className="ps__code">{project.source?.kind === "linear" ? project.source.teamId : "未设置"}</code>
                  </div>
                )}
                {source === "internal" && <div className="ps__hint">使用 Cogni 内置 tracker。</div>}
                {source === "manual"   && <div className="ps__hint">手动添加任务,不接外部 tracker。</div>}
              </div>
              <SaveBar />
            </div>
          </Section>
        )}

        {section === "runner" && (
          <Section title="Runner" subtitle="任务跑在哪儿、跑多少。">
            <div className="settings-card">
              <div className="ps__field">
                <div className="field__label">默认 host</div>
                <select className="input" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                  {MOCK_HOSTS.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}{h.status === "offline" ? " · 离线" : ""}
                    </option>
                  ))}
                </select>
                <div className="field__hint">新任务首先尝试在这台机器上跑。离线时按 SP-2 fallback 流程切换。</div>
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
              <SaveBar />
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
              <SaveBar />
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
                <button className="btn btn-sm">归档</button>
              </div>
              <div className="ps__danger-row">
                <div>
                  <div className="ps__danger-title">删除项目</div>
                  <div className="ps__danger-sub">连同所有任务、对话、artifacts 一起删,且不可恢复。</div>
                </div>
                {confirmDelete ? (
                  <div className="ps__danger-confirm">
                    <span>确定?</span>
                    <button className="btn btn-sm" onClick={() => setConfirmDelete(false)}>取消</button>
                    <button className="btn btn-sm ps__danger-delete">{Icon.trash} 永久删除</button>
                  </div>
                ) : (
                  <button className="btn btn-sm ps__danger-delete" onClick={() => setConfirmDelete(true)}>
                    {Icon.trash} 删除
                  </button>
                )}
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

function SaveBar() {
  return (
    <div className="ps__save">
      <span className="ps__save-hint">改动会自动保存</span>
      <button className="btn btn-sm btn-primary">保存</button>
    </div>
  );
}
