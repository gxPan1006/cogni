import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuthCore } from "@cogni/ui";
import { api } from "./api.js";

/**
 * /auth/google/callback — Cloud's `/auth/google/callback` ultimately bounces
 * the browser back to `https://chat.ai-cognit.com/auth/google/callback#token=<JWT>`.
 * We parse the fragment, hand the JWT to acceptToken, scrub the URL bar, and
 * navigate to /chat.
 *
 * User sees: a brief "正在登录…" placeholder, then the chat shell appears.
 * On failure (no token in URL): an error line in Chinese for the user.
 */
export function GoogleAuthCallback() {
  const { acceptToken } = useAuthCore(api);
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : "";
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    if (token) {
      acceptToken(token);
      // Remove the fragment from the address bar (cosmetic, plus avoids the
      // browser re-treating the token on refresh) then route to /chat.
      window.history.replaceState(null, "", "/chat");
      nav("/chat", { replace: true });
    } else {
      setError("登录失败：URL 中没有 token");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run exactly once on mount
  }, []);

  return <div style={{ padding: 24 }}>{error ?? "正在登录…"}</div>;
}

/**
 * /auth/email/callback?token=<magic> — Cloud's magic-link email points here
 * (for `origin=web` senders). The query-string `token` is the one-time magic
 * (not yet a JWT), so we POST it via acceptMagic to redeem a JWT.
 *
 * User sees: "正在登录…" → chat shell. If the redeem fails (link expired,
 * already used, etc.) we surface the cloud's error message inline.
 */
export function EmailAuthCallback() {
  const { acceptMagic } = useAuthCore(api);
  const nav = useNavigate();
  const loc = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(loc.search);
    const token = params.get("token");
    if (!token) {
      setError("链接无效：缺少 token 参数");
      return;
    }
    acceptMagic(token)
      .then(() => nav("/chat", { replace: true }))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "请重试";
        setError(`登录失败：${msg}`);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run exactly once on mount
  }, []);

  return <div style={{ padding: 24 }}>{error ?? "正在登录…"}</div>;
}
