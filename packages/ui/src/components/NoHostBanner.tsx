/**
 * NoHostBanner — red strip rendered above the composer when the user has zero
 * online runner hosts. Triggered by the `no-host-online` WS event; cleared via
 * useThreadStream's dismissNoHost() (UI-only — cloud has no state to clear).
 *
 * Composer should stay disabled while this is up: there's literally nowhere
 * to dispatch to.
 */
import { useTranslation } from "react-i18next";

export function NoHostBanner() {
  const { t } = useTranslation();
  return (
    <div className="no-host-banner">
      {t("chat.noHostBanner.text")}
    </div>
  );
}
