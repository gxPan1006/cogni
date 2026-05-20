import { useEffect, useState, type FormEvent } from "react";
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
 * /auth/password/callback?token=<verify> — the link in the registration email.
 * The query `token` confirms email ownership; POSTing it via passwordVerify
 * creates/merges the account, sets the password, and returns a JWT.
 *
 * User sees: "正在确认…" → chat shell. On an expired/used link: an inline error
 * with a path back to /login.
 */
export function PasswordVerifyCallback() {
  const { acceptToken } = useAuthCore(api);
  const nav = useNavigate();
  const loc = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(loc.search).get("token");
    if (!token) { setError("链接无效：缺少 token 参数"); return; }
    api.passwordVerify(token)
      .then(({ token: jwt }) => { acceptToken(jwt); nav("/chat", { replace: true }); })
      .catch(() => setError("确认失败：链接可能已过期或被使用过。"));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run exactly once on mount
  }, []);

  return (
    <div style={{ padding: 24 }}>
      {error ? <>{error} <a href="/login">返回登录</a></> : "正在确认…"}
    </div>
  );
}

/**
 * /auth/password/reset?token=<reset> — the link in the password-reset email.
 * Shows a "set a new password" form; on submit, passwordResetConfirm sets the
 * new hash and returns a JWT so the user lands straight in the app.
 */
export function PasswordResetCallback() {
  const { acceptToken } = useAuthCore(api);
  const nav = useNavigate();
  const loc = useLocation();
  const token = new URLSearchParams(loc.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return <div style={{ padding: 24 }}>链接无效：缺少 token 参数 <a href="/login">返回登录</a></div>;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError("密码至少 8 位"); return; }
    setBusy(true);
    setError(null);
    api.passwordResetConfirm(token, password)
      .then(({ token: jwt }) => { acceptToken(jwt); nav("/chat", { replace: true }); })
      .catch(() => { setError("重置失败：链接可能已过期或被使用过。"); setBusy(false); });
  };

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: 24, fontFamily: "inherit" }}>
      <h2 style={{ marginTop: 0 }}>设置新密码</h2>
      <form onSubmit={submit}>
        <input
          type="password"
          placeholder="新密码（至少 8 位）"
          value={password}
          disabled={busy}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", boxSizing: "border-box", marginBottom: 12 }}
        />
        {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%", padding: 12 }}>
          {busy ? "处理中…" : "设置新密码并登录"}
        </button>
      </form>
    </div>
  );
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
