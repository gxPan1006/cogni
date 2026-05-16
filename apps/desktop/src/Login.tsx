/**
 * Login — pre-auth landing page.
 *
 * Owned by Track C (Login + Welcome). Phase 1 settled: props (`onLogin`), root
 * className (`.login`), CSS module (`login.css`). Track C fills the visual
 * design. Visual target: dark Anthropic-style hero with brand mark + tagline
 * + the single "用 Google 登录" CTA. Keep it deliberately spartan — SP-1 has
 * no other entry point.
 *
 * Behaviour the user sees:
 *   - Fills 100vh, fully centered on the dark canvas (`--bg-app`).
 *   - Brand row: large serif wordmark "Cogni" with an Anthropic-orange ✳ to
 *     its left, sitting on the optical centerline.
 *   - Tagline underneath in dimmed body text.
 *   - Single accent-orange pill CTA "用 Google 登录" (the only entry point in
 *     SP-1). Clicking it triggers the parent's `onLogin()` which kicks off the
 *     OAuth deep-link flow.
 *   - Fine-print legal line at the bottom of the hero (placeholder copy, no
 *     real links in SP-1 — reserved hook for SP-2).
 *   - Below ~600px width the hero stays vertically centered and the wordmark
 *     scales down via responsive font-size.
 */
import "./login.css";

export function Login({ onLogin }: { onLogin: () => void }) {
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
        <button className="btn-primary login__cta" onClick={onLogin}>
          <svg
            className="login__cta-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
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
        <p className="login__legal">
          登录即代表同意《服务条款》与《隐私政策》
        </p>
      </div>
    </div>
  );
}
