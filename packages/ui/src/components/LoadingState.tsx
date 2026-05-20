import type { CSSProperties } from "react";
import "./loading.css";

type LoadingVariant = "page" | "section" | "inline";

export function LoadingState({
  title = "加载中",
  subtitle,
  variant = "section",
  className = "",
}: {
  title?: string;
  subtitle?: string;
  variant?: LoadingVariant;
  className?: string;
}) {
  const cls = ["loading-state", `loading-state--${variant}`, className].filter(Boolean).join(" ");
  return (
    <div className={cls} role="status" aria-live="polite">
      <span className="loading-state__mark" aria-hidden="true">
        <span className="loading-state__glint" />
      </span>
      <span className="loading-state__copy">
        <span className="loading-state__title">{title}</span>
        {subtitle && <span className="loading-state__subtitle">{subtitle}</span>}
      </span>
    </div>
  );
}

export function LoadingRows({
  rows = 3,
  compact = false,
  className = "",
}: {
  rows?: number;
  compact?: boolean;
  className?: string;
}) {
  const widths = ["72%", "52%", "64%", "46%"];
  const cls = ["loading-rows", compact ? "loading-rows--compact" : "", className].filter(Boolean).join(" ");
  return (
    <div className={cls} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="loading-row" key={i}>
          <span className="loading-row__avatar loading-skeleton" />
          <span className="loading-row__copy">
            <span
              className="loading-row__line loading-row__line--strong loading-skeleton"
              style={{ "--loading-row-width": widths[i % widths.length] } as CSSProperties}
            />
            <span
              className="loading-row__line loading-skeleton"
              style={{ "--loading-row-width": widths[(i + 1) % widths.length] } as CSSProperties}
            />
          </span>
        </div>
      ))}
    </div>
  );
}
