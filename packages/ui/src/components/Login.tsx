/**
 * Login — pre-auth landing page.
 *
 * Two shapes, picked by which handlers the host passes:
 *   - Magic-link only (desktop today): pass just `onLoginWithGoogle` +
 *     `onLoginWithEmail`. Renders Google → email → "发送登录链接".
 *   - Full email+password (web): also pass `onPasswordLogin` /
 *     `onPasswordRegister` / `onPasswordResetRequest`. Renders a 登录 / 注册
 *     toggle with email+password fields, a 忘记密码 link, plus Google and the
 *     magic-link fallback.
 *
 * Behavior the user sees:
 *   - 登录: type email+password → click 登录 → on success the chat shell loads;
 *     on failure an inline "邮箱或密码不正确" line, fields kept.
 *   - 注册: type email+password → click 注册 → card flips to "去邮箱确认" (we
 *     never reveal whether the email already existed). They click the emailed
 *     link to finish.
 *   - 忘记密码: type email → "发送重置链接" → same "check your inbox" card.
 *   - 发送登录链接 (magic): unchanged from before.
 */
import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { LogoMark } from "./LogoMark.js";
import "./login.css";

type Mode = "login" | "register" | "forgot";
type SentChannel = "magic" | "register" | "forgot";

type Status =
  | { kind: "idle"; error?: string }
  | { kind: "submitting" }
  | { kind: "sent"; channel: SentChannel; email: string; resendAt: number };

const RESEND_COOLDOWN_MS = 60_000;

export interface LoginProps {
  onLoginWithGoogle: () => void;
  /** Magic-link send. */
  onLoginWithEmail: (email: string) => Promise<void>;
  /** Email+password login. When omitted, the password UI is hidden entirely. */
  onPasswordLogin?: (email: string, password: string) => Promise<void>;
  /** Start password registration (sends a verification email). */
  onPasswordRegister?: (email: string, password: string) => Promise<void>;
  /** Send a password reset email. */
  onPasswordResetRequest?: (email: string) => Promise<void>;
}

export function Login(props: LoginProps) {
  const { t } = useTranslation();
  const passwordEnabled = Boolean(props.onPasswordLogin);
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (status.kind !== "sent") return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [status.kind]);

  const fail = (e: unknown) =>
    setStatus({ kind: "idle", error: e instanceof Error ? e.message : t("auth.errors.network") });

  const switchMode = (m: Mode) => {
    setMode(m);
    setStatus({ kind: "idle" });
    setPassword("");
  };

  const sendMagic = async (to: string) => {
    setStatus({ kind: "submitting" });
    try {
      await props.onLoginWithEmail(to);
      setStatus({ kind: "sent", channel: "magic", email: to, resendAt: Date.now() + RESEND_COOLDOWN_MS });
    } catch (e) { fail(e); }
  };

  const submit = async () => {
    const e = email.trim();
    if (!e.includes("@")) { setStatus({ kind: "idle", error: t("auth.errors.invalidEmail") }); return; }
    if (mode !== "forgot" && password.length < 8) {
      setStatus({ kind: "idle", error: t("auth.errors.passwordTooShort") }); return;
    }
    setStatus({ kind: "submitting" });
    try {
      if (mode === "login") {
        await props.onPasswordLogin!(e, password);
        // success → host routes away; keep "submitting" so inputs stay disabled
      } else if (mode === "register") {
        await props.onPasswordRegister!(e, password);
        setStatus({ kind: "sent", channel: "register", email: e, resendAt: Date.now() + RESEND_COOLDOWN_MS });
      } else {
        await props.onPasswordResetRequest!(e);
        setStatus({ kind: "sent", channel: "forgot", email: e, resendAt: Date.now() + RESEND_COOLDOWN_MS });
      }
    } catch (err) { fail(err); }
  };

  const resend = (to: string) => {
    if (status.kind !== "sent") return;
    if (status.channel === "magic") void sendMagic(to);
    else void submit();
  };

  return (
    <div className="login">
      <aside className="login__aside">
        <div className="login__brand">
          <LogoMark className="login__logo-mark" size={26} />
          <span className="login__wordmark-text">cogni</span>
        </div>
        <div className="login__hero">
          <h1 className="login__display">
            <Trans i18nKey="auth.hero.title" components={{ br: <br /> }} />
          </h1>
          <p className="login__lede">
            <Trans i18nKey="auth.hero.lede" components={{ br: <br /> }} />
          </p>
          <div className="login__status">
            <span className="dot dot-online" />
            <span className="login__status-text">2 OF 3 RUNNER HOSTS ONLINE · SP-1</span>
          </div>
        </div>
      </aside>

      <section className="login__form-col">
        <div className="login__card">
          {status.kind === "sent"
            ? <SentView status={status} now={now} onResend={resend} onReset={() => switchMode("login")} />
            : <FormView
                mode={mode}
                passwordEnabled={passwordEnabled}
                email={email}
                password={password}
                error={status.kind === "idle" ? status.error : undefined}
                submitting={status.kind === "submitting"}
                onEmail={setEmail}
                onPassword={setPassword}
                onMode={switchMode}
                onGoogle={props.onLoginWithGoogle}
                onSubmit={submit}
                onSendMagic={() => void sendMagic(email.trim())}
              />}
        </div>
      </section>
    </div>
  );
}

function FormView({
  mode, passwordEnabled, email, password, error, submitting,
  onEmail, onPassword, onMode, onGoogle, onSubmit, onSendMagic,
}: {
  mode: Mode;
  passwordEnabled: boolean;
  email: string;
  password: string;
  error: string | undefined;
  submitting: boolean;
  onEmail: (v: string) => void;
  onPassword: (v: string) => void;
  onMode: (m: Mode) => void;
  onGoogle: () => void;
  onSubmit: () => void;
  onSendMagic: () => void;
}) {
  const { t } = useTranslation();
  const titles: Record<Mode, { eyebrow: string; title: string; sub: string; cta: string }> = {
    login:    { eyebrow: t("auth.form.login.eyebrow"),    title: t("auth.form.login.title"),   sub: t("auth.form.login.sub"), cta: t("auth.form.login.cta") },
    register: { eyebrow: t("auth.form.register.eyebrow"), title: t("auth.form.register.title"),  sub: t("auth.form.register.sub"),   cta: t("auth.form.register.cta") },
    forgot:   { eyebrow: t("auth.form.forgot.eyebrow"),      title: t("auth.form.forgot.title"),     sub: t("auth.form.forgot.sub"), cta: t("auth.form.forgot.cta") },
  };
  const copy = titles[mode];

  return (
    <>
      <div className="login__eyebrow">{copy.eyebrow}</div>
      <div className="login__card-title">{copy.title}</div>
      <div className="login__card-sub">{copy.sub}</div>

      {passwordEnabled && mode !== "forgot" && (
        <div className="login__tabs" role="tablist">
          <button
            role="tab"
            className={`login__tab ${mode === "login" ? "login__tab--active" : ""}`}
            disabled={submitting}
            onClick={() => onMode("login")}
          >{t("auth.tabLogin")}</button>
          <button
            role="tab"
            className={`login__tab ${mode === "register" ? "login__tab--active" : ""}`}
            disabled={submitting}
            onClick={() => onMode("register")}
          >{t("auth.tabRegister")}</button>
        </div>
      )}

      <button className="login__google" onClick={onGoogle} disabled={submitting}>
        <GoogleGlyph />
        <span>{t("auth.google")}</span>
      </button>

      <div className="login__or">
        <div className="login__or-line" />
        <span className="login__or-text">{t("auth.orText")}</span>
        <div className="login__or-line" />
      </div>

      <form
        className="login__form"
        onSubmit={(e) => { e.preventDefault(); if (passwordEnabled) onSubmit(); else onSendMagic(); }}
      >
        <label className="login__label">{t("auth.emailLabel")}</label>
        <input
          type="email"
          className="login__input"
          placeholder={t("auth.emailPlaceholder")}
          value={email}
          disabled={submitting}
          autoComplete="email"
          onChange={(e) => onEmail(e.target.value)}
        />

        {passwordEnabled && mode !== "forgot" && (
          <>
            <label className="login__label">{t("auth.passwordLabel")}</label>
            <input
              type="password"
              className="login__input"
              placeholder={mode === "register" ? t("auth.passwordPlaceholderRegister") : t("auth.passwordPlaceholderLogin")}
              value={password}
              disabled={submitting}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              onChange={(e) => onPassword(e.target.value)}
            />
          </>
        )}

        {error && <div className="login__error">{error}</div>}

        {passwordEnabled ? (
          <button type="submit" className="btn btn-primary login__submit" disabled={submitting}>
            {submitting ? t("auth.submitting") : copy.cta}
          </button>
        ) : (
          <button type="submit" className="btn btn-primary login__submit" disabled={submitting}>
            {submitting ? t("auth.sendingMagic") : t("auth.sendMagicLink")}
          </button>
        )}
      </form>

      {passwordEnabled && (
        <div className="login__alts">
          {mode === "login" && (
            <button className="login__link" disabled={submitting} onClick={() => onMode("forgot")}>
              {t("auth.forgotPassword")}
            </button>
          )}
          {mode === "forgot" && (
            <button className="login__link" disabled={submitting} onClick={() => onMode("login")}>
              {t("auth.backToLogin")}
            </button>
          )}
          <button className="login__link" disabled={submitting} onClick={onSendMagic}>
            {t("auth.useMagicLink")}
          </button>
        </div>
      )}

      <p className="login__legal">
        {t("auth.legal")}
      </p>
    </>
  );
}

function SentView({
  status, now, onResend, onReset,
}: {
  status: Extract<Status, { kind: "sent" }>;
  now: number;
  onResend: (email: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const remaining = Math.max(0, Math.ceil((status.resendAt - now) / 1000));
  const copy: Record<SentChannel, { eyebrow: string; title: string }> = {
    magic:    { eyebrow: t("auth.sent.magic.eyebrow"), title: t("auth.sent.magic.title") },
    register: { eyebrow: t("auth.sent.register.eyebrow"), title: t("auth.sent.register.title") },
    forgot:   { eyebrow: t("auth.sent.forgot.eyebrow"), title: t("auth.sent.forgot.title") },
  };
  const c = copy[status.channel];
  return (
    <>
      <div className="login__eyebrow login__eyebrow--good">{c.eyebrow}</div>
      <div className="login__card-title">{c.title}</div>
      <div className="login__card-sub">
        <Trans
          i18nKey="auth.sent.body"
          values={{ email: status.email }}
          components={[<strong key="email" />, <br key="br" />]}
        />
      </div>
      <button className="btn btn-primary login__submit" disabled={remaining > 0} onClick={() => onResend(status.email)}>
        {remaining > 0 ? t("auth.sent.resendIn", { seconds: remaining }) : t("auth.sent.resend")}
      </button>
      <button className="login__link" onClick={onReset}>
        {t("auth.sent.useOtherEmail")}
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
