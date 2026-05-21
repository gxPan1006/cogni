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
 * "删除项目" is left as a UI-only step in SP-3: archive is the supported
 * lifecycle. The button looks the same but routes to `onArchive` rather
 * than a separate delete endpoint.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project, MergePolicy } from "@cogni/contract";
import type { HostInfo, UpdateProjectInput } from "../../transport/api.js";
import { Icon } from "../icons.js";
import { LoadingRows, LoadingState } from "../LoadingState.js";
import "./project-settings.css";

type Section = "basics" | "runner" | "prompt" | "danger";

export function ProjectSettings({
  project,
  hosts,
  loading = false,
  onClose,
  onUpdate,
  onArchive,
}: {
  project: Project | null;
  hosts: HostInfo[];
  loading?: boolean;
  onClose: () => void;
  onUpdate?: (patch: UpdateProjectInput) => Promise<void> | void;
  onArchive?: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("basics");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hostId, setHostId] = useState("");
  const [concurrency, setConcurrency] = useState(2);
  const [prompt, setPrompt] = useState("");
  const [mergePolicy, setMergePolicy] = useState<MergePolicy>("require-review");
  const [pushToRemote, setPushToRemote] = useState(false);
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
    setPushToRemote(project.pushToRemote);
  }, [project]);

  if (!project) {
    return (
      <div className="ps ps--loading" aria-busy={loading}>
        <aside className="ps__nav">
          <div className="ps__nav-head">
            <button className="ps__icon-btn" onClick={onClose} title={t("project.settings.back")}>{Icon.x}</button>
            <div className="ps__nav-text">
              <div className="ps__nav-eyebrow">{t("project.settings.eyebrow")}</div>
              <div className="ps__nav-name">{loading ? t("project.settings.syncing") : t("project.settings.notFound")}</div>
            </div>
          </div>
        </aside>
        <main className="ps__body">
          {loading ? (
            <>
              <LoadingState variant="section" title={t("project.settings.loadingTitle")} subtitle={t("project.settings.loadingSubtitle")} />
              <div className="settings-card ps__loading-card">
                <LoadingRows rows={4} />
              </div>
            </>
          ) : (
            <div className="settings-card ps__loading-card">
              <div className="ps__empty">{t("project.settings.notFoundBody")}</div>
            </div>
          )}
        </main>
      </div>
    );
  }

  const saveBasics = () =>
    void onUpdate?.({ name, description: description || null });
  const saveRunner = () =>
    void onUpdate?.({ defaultHostId: hostId, concurrencyLimit: concurrency, mergePolicy, pushToRemote });
  const savePrompt = () =>
    void onUpdate?.({ systemPrompt: prompt || null });

  return (
    <div className="ps">
      <aside className="ps__nav">
        <div className="ps__nav-head">
          <button className="ps__icon-btn" onClick={onClose} title={t("project.settings.back")}>{Icon.x}</button>
          <div className="ps__nav-text">
            <div className="ps__nav-eyebrow">{t("project.settings.eyebrow")}</div>
            <div className="ps__nav-name">{project.name}</div>
          </div>
        </div>
        <nav className="ps__menu">
          <NavBtn id="basics"  active={section} onClick={setSection} icon={Icon.edit}>{t("project.settings.navBasics")}</NavBtn>
          <NavBtn id="runner"  active={section} onClick={setSection} icon={Icon.bolt}>{t("project.settings.navRunner")}</NavBtn>
          <NavBtn id="prompt"  active={section} onClick={setSection} icon={Icon.brain}>{t("project.settings.navPrompt")}</NavBtn>
          <NavBtn id="danger"  active={section} onClick={setSection} icon={Icon.trash} danger>{t("project.settings.navDanger")}</NavBtn>
        </nav>
      </aside>

      <main className="ps__body">
        {section === "basics" && (
          <Section title={t("project.settings.basicsTitle")} subtitle={t("project.settings.basicsSubtitle")}>
            <div className="settings-card">
              <div className="ps__field">
                <div className="field__label">{t("project.settings.fieldName")}</div>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="ps__field">
                <div className="field__label">{t("project.settings.fieldDescription")}</div>
                <textarea className="input ps__textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
              </div>
              <SaveBar onSave={saveBasics} />
            </div>
          </Section>
        )}

        {section === "runner" && (
          <Section title={t("project.settings.runnerTitle")} subtitle={t("project.settings.runnerSubtitle")}>
            <div className="settings-card">
              <div className="ps__field">
                <div className="field__label">{t("project.settings.defaultHost")}</div>
                <select className="input" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}{h.status === "offline" ? t("project.settings.hostOffline") : ""}
                    </option>
                  ))}
                </select>
                <div className="field__hint">{t("project.settings.defaultHostHint")}</div>
              </div>
              <div className="ps__field">
                <div className="field__label">{t("project.settings.mergePolicy")}</div>
                <select className="input" value={mergePolicy} onChange={(e) => setMergePolicy(e.target.value as MergePolicy)}>
                  <option value="require-review">require-review</option>
                  <option value="auto-merge">auto-merge</option>
                  <option value="auto-merge-if-tests-pass">auto-merge-if-tests-pass</option>
                </select>
              </div>
              <div className="ps__field">
                <div className="field__label">{t("project.settings.concurrency")}</div>
                <div className="np__stepper">
                  <button className="btn btn-sm btn-ghost" onClick={() => setConcurrency(Math.max(1, concurrency - 1))} disabled={concurrency <= 1}>−</button>
                  <div className="np__stepper-value">{concurrency}</div>
                  <button className="btn btn-sm btn-ghost" onClick={() => setConcurrency(Math.min(16, concurrency + 1))} disabled={concurrency >= 16}>+</button>
                </div>
                <div className="field__hint">{t("project.settings.concurrencyHint")}</div>
              </div>
              <div className="ps__field">
                <label className="ps__check">
                  <input
                    type="checkbox"
                    checked={pushToRemote}
                    onChange={(e) => setPushToRemote(e.target.checked)}
                  />
                  <span>{t("project.settings.pushToRemote")}</span>
                </label>
                <div className="field__hint">{t("project.settings.pushToRemoteHint")}</div>
              </div>
              <SaveBar onSave={saveRunner} />
            </div>
          </Section>
        )}

        {section === "prompt" && (
          <Section title={t("project.settings.promptTitle")} subtitle={t("project.settings.promptSubtitle")}>
            <div className="settings-card">
              <div className="ps__field">
                <textarea className="input ps__textarea ps__textarea--lg" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("project.settings.promptPlaceholder")} rows={8} />
                <div className="field__hint">{t("project.settings.promptCharsHint", { n: prompt.length })}</div>
              </div>
              <SaveBar onSave={savePrompt} />
            </div>
          </Section>
        )}

        {section === "danger" && (
          <Section title={t("project.settings.dangerTitle")} subtitle={t("project.settings.dangerSubtitle")}>
            <div className="settings-card ps__danger-card">
              <div className="ps__danger-row">
                <div>
                  <div className="ps__danger-title">{t("project.settings.archiveTitle")}</div>
                  <div className="ps__danger-sub">{t("project.settings.archiveSub")}</div>
                </div>
                {confirmArchive ? (
                  <div className="ps__danger-confirm">
                    <span>{t("project.settings.confirmArchive")}</span>
                    <button className="btn btn-sm" onClick={() => setConfirmArchive(false)}>{t("project.settings.cancel")}</button>
                    <button className="btn btn-sm ps__danger-delete" onClick={() => { void onArchive?.(); setConfirmArchive(false); }}>{t("project.settings.archive")}</button>
                  </div>
                ) : (
                  <button className="btn btn-sm" onClick={() => setConfirmArchive(true)}>{t("project.settings.archive")}</button>
                )}
              </div>
              <div className="ps__danger-row">
                <div>
                  <div className="ps__danger-title">{t("project.settings.deleteTitle")}</div>
                  <div className="ps__danger-sub">{t("project.settings.deleteSub")}</div>
                </div>
                <button className="btn btn-sm ps__danger-delete" disabled title={t("project.settings.deleteUnavailableTitle")}>
                  {Icon.trash} {t("project.settings.deleteUnavailable")}
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
  const { t } = useTranslation();
  return (
    <div className="ps__save">
      <span className="ps__save-hint">{t("project.settings.saveHint")}</span>
      <button className="btn btn-sm btn-primary" onClick={onSave}>{t("project.settings.save")}</button>
    </div>
  );
}
