/**
 * NoHostBanner — red strip rendered above the composer when the user has zero
 * online runner hosts. Triggered by the `no-host-online` WS event; cleared via
 * useThreadStream's dismissNoHost() (UI-only — cloud has no state to clear).
 *
 * Composer should stay disabled while this is up: there's literally nowhere
 * to dispatch to.
 */
export function NoHostBanner() {
  return (
    <div className="no-host-banner">
      🔌 没有在线的 cogni 桌面端 — 至少打开一台 Mac 上的 cogni app 才能发消息。
    </div>
  );
}
