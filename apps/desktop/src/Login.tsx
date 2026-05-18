/**
 * Login — pre-auth landing page.
 *
 * State machine (unchanged from SP-1):
 *   form     — initial; show email input + Google button
 *   sending  — POST /auth/email/send in flight; disable inputs
 *   sent     — email queued; show "check your inbox" + 60s resend cooldown
 *   error    — inline error, keep email pre-filled
 *
 * Visual rewrite:
 *   - Two-column layout: brand panel on the left, form card on the right
 *   - Brand panel shows the wordmark + tagline + "2 of 3 hosts online" line
 *     (purely decorative copy at this stage; SP-2 may surface real counts)
 *   - Form card: Google button → divider → email input → submit
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

  return (
    <div className="login">
      <aside className="login__aside">
        <div className="login__brand">
          <span className="login__wordmark-c">c</span>
          <span className="login__wordmark-text">cogni</span>
        </div>
        <div className="login__hero">
          <h1 className="login__display">
            一台安静的机器,<br/>住在你已有的设备里。
          </h1>
          <p className="login__lede">
            你的账号、对话、项目都在云端。<br/>
            任务跑在你哪台机器正巧在线。
          </p>
          <div className="login__status">
            <span className="dot dot-online" />
            <span className="login__status-text">2 OF 3 RUNNER HOSTS ONLINE · SP-1</span>
          </div>
        </div>
      </aside>

      <section className="login__form-col">
        <div className="login__card">
          {state.kind === "sent" ? <SentView state={state} now={now} onResend={submitEmail} onReset={() => setState({ kind: "form", email: "" })} />
                                  : <FormView state={state} onState={setState} onGoogle={onLoginWithGoogle} onSubmit={submitEmail} />}
        </div>
      </section>
    </div>
  );
}

function FormView({
  state, onState, onGoogle, onSubmit,
}: {
  state: Exclude<State, { kind: "sent" }>;
  onState: (s: State) => void;
  onGoogle: () => void;
  onSubmit: (email: string) => Promise<void>;
}) {
  const email = state.email;
  const error = state.kind === "error" ? state.reason : state.kind === "form" ? state.error : undefined;
  const isSubmitting = state.kind === "sending";

  return (
    <>
      <div className="login__eyebrow">WELCOME</div>
      <div className="login__card-title">登录 Cogni</div>
      <div className="login__card-sub">一个账号,所有设备同步</div>

      <button className="login__google" onClick={onGoogle} disabled={isSubmitting}>
        <GoogleGlyph />
        <span>用 Google 登录</span>
      </button>

      <div className="login__or">
        <div className="login__or-line" />
        <span className="login__or-text">OR</span>
        <div className="login__or-line" />
      </div>

      <form
        className="login__form"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = email.trim();
          if (!trimmed.includes("@")) {
            onState({ kind: "form", email, error: "请输入合法的邮箱地址" });
            return;
          }
          void onSubmit(trimmed);
        }}
      >
        <label className="login__label">邮箱</label>
        <input
          type="email"
          className="login__input"
          placeholder="you@somewhere.com"
          value={email}
          disabled={isSubmitting}
          autoComplete="email"
          onChange={(e) => onState({ kind: "form", email: e.target.value })}
        />
        {error && <div className="login__error">{error}</div>}
        <button type="submit" className="btn btn-primary login__submit" disabled={isSubmitting}>
          {isSubmitting ? "发送中…" : "发送登录链接"}
        </button>
      </form>

      <p className="login__legal">
        登录即代表同意《服务条款》与《隐私政策》。SP-1 是开发版本。
      </p>
    </>
  );
}

function SentView({
  state, now, onResend, onReset,
}: {
  state: Extract<State, { kind: "sent" }>;
  now: number;
  onResend: (email: string) => void;
  onReset: () => void;
}) {
  const remaining = Math.max(0, Math.ceil((state.resendAt - now) / 1000));
  return (
    <>
      <div className="login__eyebrow login__eyebrow--good">CHECK YOUR EMAIL</div>
      <div className="login__card-title">登录链接已发送</div>
      <div className="login__card-sub">
        我们把链接发到了 <strong>{state.email}</strong>。<br/>
        在任意设备上点开都可以,15 分钟内有效。
      </div>
      <button className="btn btn-primary login__submit" disabled={remaining > 0} onClick={() => onResend(state.email)}>
        {remaining > 0 ? `${remaining}s 后可重发` : "重发邮件"}
      </button>
      <button className="login__link" onClick={onReset}>
        用其他邮箱?
      </button>
    </>
  );
}

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4c-.2 1.2-.9 2.3-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" fill="#4285F4"/>
      <path d="M12 22c2.7 0 5-1 6.6-2.5l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.7-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853"/>
      <path d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6z" fill="#FBBC04"/>
      <path d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.7 9.4 6.1 12 6.1z" fill="#EA4335"/>
    </svg>
  );
}
