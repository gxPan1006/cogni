import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api.js";

const TOKEN_KEY = "cogni_token";

/**
 * Holds the session JWT and routes incoming `cogni://auth?…` deep links to
 * the right auth flow.
 *
 * Two URL shapes arrive at `cogni://auth`:
 *   ?token=<JWT>   — Google OAuth callback (cloud signs the JWT server-side,
 *                    hands it back in the redirect URL; we just store it)
 *   ?magic=<rand>  — Email magic link (we must POST it to
 *                    /auth/email/callback to exchange for a JWT)
 *
 * Behaviour the user sees:
 *   - Click "用 Google 登录" → system browser opens, completes OAuth, macOS
 *     routes `cogni://auth?token=…` back to Cogni → app drops into Welcome.
 *   - Click "发送登录链接" → Login flips to "已发送…" → user clicks the link
 *     in their email client → macOS routes `cogni://auth?magic=…` back here
 *     → useAuth POSTs to /auth/email/callback → app drops into Welcome.
 */
export function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const acceptUrls = async (urls: string[] | null) => {
      if (disposed || !urls) return;
      for (const u of urls) {
        const parsed = tryParse(u);
        if (!parsed) continue;
        if (parsed.kind === "token") {
          localStorage.setItem(TOKEN_KEY, parsed.value);
          setToken(parsed.value);
        } else if (parsed.kind === "magic") {
          try {
            const { token: jwt } = await api.redeemMagic(parsed.value);
            localStorage.setItem(TOKEN_KEY, jwt);
            setToken(jwt);
          } catch (e) {
            console.warn("[useAuth] magic redeem failed", e);
          }
        }
      }
    };

    getCurrent().then(acceptUrls).catch((e) => console.warn("failed to read current deep link", e));
    const unlisten = onOpenUrl((urls) => {
      void acceptUrls(urls);
    });
    return () => {
      disposed = true;
      unlisten.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // Dev fallback: when running under `vite dev` (import.meta.env.DEV is true)
  // and the user has no token, ask the cloud for one. This bypasses Google
  // OAuth entirely so dogfood works on networks where Google is unreachable.
  // `vite build` for production dead-code-eliminates the entire effect (the
  // `import.meta.env.DEV` constant becomes `false` and the branch drops out).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (token) return;
    let alive = true;
    fetch(`${api.cloudUrl}/auth/dev-token`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && typeof j.token === "string") {
          localStorage.setItem(TOKEN_KEY, j.token);
          setToken(j.token);
        }
      })
      .catch((e) => console.warn("[useAuth] dev-token fetch failed", e));
    return () => {
      alive = false;
    };
  }, [token]);

  const loginWithGoogle = () => {
    const url = `${api.cloudUrl}/auth/google/start?redirect=${encodeURIComponent("cogni://auth")}`;
    if (!isTauri()) {
      window.location.href = url;
      return;
    }
    return openUrl(url);
  };

  const loginWithEmail = async (email: string): Promise<void> => {
    await api.sendMagicLink(email);
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
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
