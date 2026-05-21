/**
 * ModelSelector — the composer's model picker. A compact pill (● label ▾) that
 * opens a dropdown of the curated CHAT_MODELS. Cohesive with the warm-sand
 * tokens; replaces the old static "claude-code" label.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./model-selector.css";

export interface ModelOption {
  id: string;
  label: string;
}

export function ModelSelector({
  models,
  value,
  onChange,
  disabled,
}: {
  models: readonly ModelOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = models.find((m) => m.id === value) ?? models[0];

  return (
    <div className="model-sel" ref={rootRef}>
      <button
        type="button"
        className="model-sel__btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t("chat.model.selectTitle")}
      >
        <span className="model-sel__dot" aria-hidden="true" />
        <span className="model-sel__label">{current?.label ?? value}</span>
        <span className="model-sel__caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="model-sel__menu" role="listbox">
          {models.map((m) => (
            <button
              type="button"
              key={m.id}
              role="option"
              aria-selected={m.id === value}
              className={"model-sel__opt" + (m.id === value ? " model-sel__opt--sel" : "")}
              onClick={() => { onChange(m.id); setOpen(false); }}
            >
              <span className="model-sel__opt-text">
                <span className="model-sel__opt-name">{m.label}</span>
                <span className="model-sel__opt-id">{m.id}</span>
              </span>
              {m.id === value && <span className="model-sel__check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
