/**
 * InstallPrompt — nudges mobile users to install the PWA to their home screen.
 *
 * Two paths, because the platforms differ:
 *   - Android / desktop Chromium fire `beforeinstallprompt`. We capture it and
 *     show an "Install" button that triggers the native install dialog.
 *   - iOS Safari fires nothing and offers no programmatic install — the user
 *     must tap Share → "Add to Home Screen" by hand. iOS also won't deliver
 *     web-push until the app is installed this way, so the nudge matters more
 *     here. We show a one-line instruction with the Share glyph.
 *
 * Web-only (lives in apps/web, not @cogni/ui): the Tauri desktop app is already
 * a native window, so "add to home screen" is meaningless there. Dismissal is
 * remembered so we never nag twice.
 */
import { useEffect, useState } from "react";
import { useLocale } from "@cogni/ui";
import "./styles/install-prompt.css";

const DISMISS_KEY = "cogni:install-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari exposes this non-standard flag when launched from home screen.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as MacIntel but is touch-capable.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isIOSSafari(): boolean {
  // Only Safari on iOS can add to the home screen — Chrome/Firefox on iOS can't.
  const ua = navigator.userAgent;
  return isIOS() && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
}

export function InstallPrompt() {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOS, setShowIOS] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (dismissed || isStandalone()) return;

    const onBIP = (e: Event) => {
      e.preventDefault(); // stop Chrome's mini-infobar; we drive our own UI
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBIP);

    // No beforeinstallprompt on iOS — show the manual hint there instead.
    if (isIOSSafari()) setShowIOS(true);

    // Hide once installed.
    const onInstalled = () => dismiss();
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed]);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode — fine, just won't persist */
    }
    setDismissed(true);
    setDeferred(null);
    setShowIOS(false);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    dismiss();
  }

  if (dismissed) return null;
  if (!deferred && !showIOS) return null;

  return (
    <div className="install-prompt" role="dialog" aria-live="polite">
      <div className="install-prompt__text">
        {deferred ? (
          zh ? "把 Cogni 装到主屏,像 app 一样用" : "Install Cogni to your home screen"
        ) : (
          <>
            {zh ? "安装 Cogni:点 " : "Install Cogni: tap "}
            <ShareGlyph />
            {zh ? " 再选「添加到主屏幕」" : " then “Add to Home Screen”"}
          </>
        )}
      </div>
      <div className="install-prompt__actions">
        {deferred && (
          <button className="install-prompt__cta" onClick={install}>
            {zh ? "安装" : "Install"}
          </button>
        )}
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

/** iOS Safari Share icon (square with up-arrow) so the hint matches what the
 *  user actually sees in the browser chrome. */
function ShareGlyph() {
  return (
    <svg
      className="install-prompt__share"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}
