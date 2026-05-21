/**
 * NewTask — modal for filing a task inside a project.
 *
 * (Shared component lifted from apps/desktop/src/NewTask.tsx.)
 *
 * Cogni treats a task as a direct instruction to a supervised runner. External
 * tracker imports are intentionally kept outside this surface.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons.js";
import type { HostInfo } from "../../transport/api.js";
import "./new-task.css";

export type NewTaskDraft = { title: string; description: string; hostId?: string };

export function NewTask({
  onClose,
  onCreate,
  hosts = [],
  defaultHostId,
}: {
  onClose: () => void;
  onCreate?: (draft: NewTaskDraft) => void | Promise<void>;
  /** Hosts the user can pick from; when ≤1 the picker is hidden. */
  hosts?: HostInfo[];
  /** The project's default host id, shown as the picker's default option. */
  defaultHostId?: string;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // "" = use project default; otherwise an explicit host override.
  const [hostId, setHostId] = useState("");

  const canSubmit = title.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    void onCreate?.({ title, description, hostId: hostId || undefined });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal nt" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <div>
            <div className="modal__eyebrow">{t("project.newTask.eyebrow")}</div>
            <h2 className="modal__title">{t("project.newTask.title")}</h2>
          </div>
          <button className="modal__close" onClick={onClose} title={t("project.newTask.close")}>{Icon.x}</button>
        </header>

        <div className="modal__body">
          <div className="field">
            <div className="field__label">{t("project.newTask.fieldTitle")}<span className="field__required">*</span></div>
            <input className="input" placeholder={t("project.newTask.fieldTitlePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <div className="field__label">{t("project.newTask.fieldDescription")}</div>
            <textarea className="input nt__textarea" placeholder={t("project.newTask.fieldDescriptionPlaceholder")} value={description} onChange={(e) => setDescription(e.target.value)} rows={6} />
            <div className="field__hint">{t("project.newTask.fieldDescriptionHint")}</div>
          </div>
          {hosts.length > 1 && (
            <div className="field">
              <div className="field__label">{t("project.newTask.runHost")}</div>
              <select className="input" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                <option value="">
                  {defaultHostId
                    ? t("project.newTask.projectDefaultNamed", { name: hosts.find((h) => h.id === defaultHostId)?.name ?? t("project.newTask.defaultHostFallback") })
                    : t("project.newTask.projectDefault")}
                </option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}{h.status === "online" ? "" : t("project.newTask.hostOffline")}
                  </option>
                ))}
              </select>
              <div className="field__hint">{t("project.newTask.runHostHint")}</div>
            </div>
          )}
        </div>

        <footer className="modal__foot">
          <button className="btn btn-sm" onClick={onClose}>{t("project.newTask.cancel")}</button>
          <button className="btn btn-sm btn-primary" disabled={!canSubmit} onClick={submit}>
            {Icon.plus} {t("project.newTask.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}
