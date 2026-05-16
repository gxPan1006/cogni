/**
 * Login — pre-auth landing page.
 *
 * Two CTAs that both end in a `cogni://auth?…` deep link delivered to useAuth:
 *   1. Email magic link: type address → POST /auth/email/send → switch to "sent"
 *      state with a 60s resend cooldown. User opens email client, clicks the link,
 *      macOS routes cogni:// back to Cogni, useAuth redeems and sets the JWT.
 *   2. Google OAuth: standard browser-redirect dance, server-side callback,
 *      JWT comes back in the cogni:// URL.
 *
 * State machine:
 *   form     — initial; show email input + Google button
 *   sending  — POST /auth/email/send in flight; disable inputs
 *   sent     — email queued; show "check your inbox" + resend countdown
 *   error    — show inline error, keep the user's email pre-filled
 *
 * Behaviour the user sees end-to-end:
 *   - On open: serif "Cogni" wordmark + orange ✳, tagline, email input with
 *     placeholder `you@example.com`, orange "发送登录链接" pill, "或" divider,
 *     bordered "用 Google 登录" button, fine-print legal line.
 *   - On submit (valid email): the form's button text flips to "发送中…" and
 *     disables; on success the whole hero swaps to the "已发送 ..." card
 *     with a "60s 后可重发" button (counts down 1Hz) and an underlined
 *     "用其他邮箱?" link that returns to the form.
 *   - On invalid email: inline red error under the input ("请输入合法的邮箱地址"),
 *     the input stays focused so the user can fix it in place.
 *   - On network/4xx error: same inline error, content from ApiError.message
 *     (typically "POST .../send → 429" for rate-limit; we render the raw msg —
 *     not pretty, but informative for SP-1 dogfood).
 */
import { useEffect, useState } from "react";
import "./login.css";

type State =
  | { kind: "form"; email: string; error?: string }
  | { kind: "sending"; email: string }
  | { kind: "sent"; email: string; resendAt: number }
  | { kind: "error"; email: string; reason: string };

const RESEND_COOLDOWN_MS = 60_000;

export function Login({
  onLoginWithGoogle,
  onLoginWithEmail,
}: {
  onLoginWithGoogle: () => void;
  onLoginWithEmail: (email: string) => Promise<void>;
}) {
  const [state, setState] = useState<State>({ kind: "form", email: "" });
  const [now, setNow] = useState(Date.now());

  // tick once a second when in 'sent' state so the cooldown label updates
  useEffect(() => {
    if (state.kind !== "sent") return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [state.kind]);

  const submitEmail = async (email: string) => {
    setState({ kind: "sending", email });
    try {
      await onLoginWithEmail(email);
      setState({ kind: "sent", email, resendAt: Date.now() + RESEND_COOLDOWN_MS });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "网络错误,请重试";
      setState({ kind: "error", email, reason });
    }
  };

  if (state.kind === "sent") {
    const remaining = Math.max(0, Math.ceil((state.resendAt - now) / 1000));
    return (
      <div className="login">
        <div className="login__hero">
          <div className="login__brand">
            <span className="login__star" aria-hidden="true">
              ✳
            </span>
            <h1 className="login__title">Cogni</h1>
          </div>
          <p className="login__subtitle">
            已发送登录链接到 <strong>{state.email}</strong>,请在邮件中点击「登录 Cogni」
          </p>
          <button
            className="btn-primary login__cta"
            disabled={remaining > 0}
            onClick={() => submitEmail(state.email)}
          >
            {remaining > 0 ? `${remaining}s 后可重发` : "重发邮件"}
          </button>
          <button
            className="login__link"
            onClick={() => setState({ kind: "form", email: "" })}
          >
            用其他邮箱?
          </button>
        </div>
      </div>
    );
  }

  const formEmail =
    state.kind === "form"
      ? state.email
      : state.kind === "error"
        ? state.email
        : state.kind === "sending"
          ? state.email
          : "";
  const formError =
    state.kind === "error"
      ? state.reason
      : state.kind === "form"
        ? state.error
        : undefined;
  const isSubmitting = state.kind === "sending";

  return (
    <div className="login">
      <div className="login__hero">
        <div className="login__brand">
          <span className="login__star" aria-hidden="true">
            ✳
          </span>
          <h1 className="login__title">Cogni</h1>
        </div>
        <p className="login__subtitle">有记忆、跨设备在场的 AI 助手</p>

        <form
          className="login__form"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = formEmail.trim();
            if (!trimmed.includes("@")) {
              setState({ kind: "form", email: formEmail, error: "请输入合法的邮箱地址" });
              return;
            }
            void submitEmail(trimmed);
          }}
        >
          <input
            type="email"
            className="login__input"
            placeholder="you@example.com"
            value={formEmail}
            disabled={isSubmitting}
            autoComplete="email"
            onChange={(e) => setState({ kind: "form", email: e.target.value })}
          />
          {formError && <div className="login__error">{formError}</div>}
          <button type="submit" className="btn-primary login__cta" disabled={isSubmitting}>
            {isSubmitting ? "发送中…" : "发送登录链接"}
          </button>
        </form>

        <div className="login__divider">
          <span>或</span>
        </div>

        <button
          className="login__google"
          onClick={onLoginWithGoogle}
          disabled={isSubmitting}
        >
          <svg className="login__cta-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M21.6 12.227c0-.709-.064-1.39-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.995 3.018v2.51h3.232c1.891-1.742 2.981-4.305 2.981-7.351z"
            />
            <path
              fill="currentColor"
              d="M12 22c2.7 0 4.964-.895 6.619-2.422l-3.232-2.51c-.896.6-2.042.955-3.387.955-2.605 0-4.81-1.76-5.598-4.123H3.064v2.59A9.996 9.996 0 0 0 12 22z"
            />
            <path
              fill="currentColor"
              d="M6.402 13.9A6.01 6.01 0 0 1 6.09 12c0-.659.114-1.3.312-1.9V7.51H3.064A9.996 9.996 0 0 0 2 12c0 1.614.386 3.14 1.064 4.49l3.338-2.59z"
            />
            <path
              fill="currentColor"
              d="M12 5.977c1.468 0 2.786.504 3.823 1.494l2.868-2.868C16.96 2.99 14.696 2 12 2 8.09 2 4.71 4.245 3.064 7.51l3.338 2.59C7.19 7.737 9.395 5.977 12 5.977z"
            />
          </svg>
          <span>用 Google 登录</span>
        </button>

        <p className="login__legal">登录即代表同意《服务条款》与《隐私政策》</p>
      </div>
    </div>
  );
}
