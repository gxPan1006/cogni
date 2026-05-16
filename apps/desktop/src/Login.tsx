/**
 * Login — pre-auth landing page.
 *
 * Owned by Track C (Login + Welcome). Phase 1 settled: props (`onLogin`), root
 * className (`.login`), CSS module (`login.css`). Track C fills the visual
 * design. Visual target: dark Anthropic-style hero with brand mark + tagline
 * + the single "用 Google 登录" CTA. Keep it deliberately spartan — SP-1 has
 * no other entry point.
 */
import "./login.css";

export function Login({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="login">
      <div className="login__hero">
        <h1 className="login__title">Cogni</h1>
        <p className="login__subtitle">有记忆、跨设备在场的 AI 助手</p>
        <button className="btn-primary login__cta" onClick={onLogin}>
          用 Google 登录
        </button>
      </div>
    </div>
  );
}
