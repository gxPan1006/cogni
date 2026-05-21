/**
 * NotificationsPrompt — offers to turn on push notifications once the PWA is
 * installed. We gate on standalone (installed) because that's when push is
 * actually useful and, on iOS, the only context where it works at all.
 *
 * Visible only when: push is supported, the app runs standalone, the cloud has
 * push configured (VAPID key fetch succeeds), permission is still "default",
 * and there's no existing subscription. On enable we request permission +
 * subscribe + register with the cloud (see push.ts).
 */
import { useEffect, useState } from "react";
import { useLocale } from "@cogni/ui";
import { isPushSupported, fetchVapidPublicKey, hasPushSubscription, enablePush } from "./push.js";
import "./styles/install-prompt.css";

const DISMISS_KEY = "cogni:push-dismissed";

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function NotificationsPrompt() {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (localStorage.getItem(DISMISS_KEY) === "1") return;
        if (!isPushSupported() || !isStandalone()) return;
        if (Notification.permission !== "default") return; // already granted/denied
        if (await hasPushSubscription()) return;
        const key = await fetchVapidPublicKey();
        if (!key) return; // push not configured server-side
        if (!cancelled) setShow(true);
      } catch {
        /* stay hidden on any probe failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode */
    }
    setShow(false);
  }

  async function enable() {
    setBusy(true);
    try {
      await enablePush(locale);
    } finally {
      setBusy(false);
      // Whether granted or denied, the browser won't ask again — hide either way.
      dismiss();
    }
  }

  if (!show) return null;

  return (
    <div className="install-prompt" role="dialog" aria-live="polite">
      <div className="install-prompt__text">
        {zh ? "任务完成时通知我(锁屏也能收到)" : "Notify me when tasks finish (even when closed)"}
      </div>
      <div className="install-prompt__actions">
        <button className="install-prompt__cta" onClick={enable} disabled={busy}>
          {busy ? (zh ? "开启中…" : "Enabling…") : zh ? "开启" : "Enable"}
        </button>
        <button
          className="install-prompt__close"
          onClick={dismiss}
          aria-label={zh ? "关闭" : "Dismiss"}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
