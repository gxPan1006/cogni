import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAuthCore } from "@cogni/ui";
import { api } from "./api.js";

/**
 * Desktop's Tauri shim around the platform-agnostic useAuthCore.
 *
 * Two URL shapes arrive via the `cogni://auth?…` deep link:
 *   ?token=<JWT>   — Google OAuth callback (cloud signs the JWT server-side,
 *                    hands it back in the redirect URL; we just acceptToken)
 *   ?magic=<rand>  — Email magic link (we POST to /auth/email/callback via
 *                    acceptMagic to exchange for a JWT)
 *
 * Behaviour the user sees:
 *   - Click "用 Google 登录" → system browser opens, completes OAuth, macOS
 *     routes `cogni://auth?token=…` back → app drops into Welcome.
 *   - Click "发送登录链接" → Login flips to "已发送…" → user clicks the link
 *     in their email client → macOS routes `cogni://auth?magic=…` back here
 *     → useAuth POSTs to /auth/email/callback → app drops into Welcome.
 *   - In `vite dev` only: if no token yet, POST /auth/dev-token to bypass
 *     Google entirely (dogfood on flaky-GFW networks).
 */
export function useAuth() {
  const { token, acceptToken, acceptMagic, logout } = useAuthCore(api);

  // Tauri deep-link intake
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const acceptUrls = async (urls: string[] | null) => {
      if (disposed || !urls) return;
      for (const u of urls) {
        const parsed = tryParse(u);
        if (!parsed) continue;
        if (parsed.kind === "token") acceptToken(parsed.value);
        else if (parsed.kind === "magic") {
          await acceptMagic(parsed.value).catch((e) => console.warn("[useAuth] magic redeem failed", e));
        }
      }
    };
    getCurrent().then(acceptUrls).catch((e) => console.warn("failed to read current deep link", e));
    const unlisten = onOpenUrl((urls) => { void acceptUrls(urls); });
    return () => {
      disposed = true;
      unlisten.then((f) => f()).catch(() => undefined);
    };
  }, [acceptToken, acceptMagic]);

  // Dev fallback — only runs in `vite dev`; production build dead-code-eliminates
  // the entire effect because `import.meta.env.DEV` becomes a literal `false`.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (token) return;
    let alive = true;
    fetch(`${api.cloudUrl}/auth/dev-token`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && typeof j.token === "string") acceptToken(j.token);
      })
      .catch((e) => console.warn("[useAuth] dev-token fetch failed", e));
    return () => { alive = false; };
  }, [token, acceptToken]);

  const loginWithGoogle = () => {
    const url = `${api.cloudUrl}/auth/google/start?redirect=${encodeURIComponent("cogni://auth")}`;
    if (!isTauri()) {
      window.location.href = url;
      return;
    }
    return openUrl(url);
  };

  const loginWithEmail = async (email: string): Promise<void> => {
    await api.sendMagicLink(email, "desktop");
  };

  return { token, loginWithGoogle, loginWithEmail, logout };
}

function tryParse(rawUrl: string): { kind: "token" | "magic"; value: string } | null {
  try {
    const u = new URL(rawUrl);
    const t = u.searchParams.get("token");
    if (t) return { kind: "token", value: t };
    const m = u.searchParams.get("magic");
    if (m) return { kind: "magic", value: m };
  } catch {
    /* fall through */
  }
  return null;
}
