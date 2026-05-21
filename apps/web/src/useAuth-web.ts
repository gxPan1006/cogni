import { useAuthCore, useTranslation } from "@cogni/ui";
import { api, ApiError } from "./api.js";

/**
 * Web's redirect-based shim around the platform-agnostic useAuthCore.
 *
 * Unlike desktop (which routes via Tauri deep-link `cogni://auth?token=…`),
 * the web app rides browser navigation:
 *
 *   - loginWithGoogle: top-level redirect to the cloud's `/auth/google/start`
 *     with `origin=web`. The cloud picks `chat.ai-cognit.com/auth/google/callback`
 *     as the registered Google OAuth redirect_uri and, after the round-trip,
 *     bounces the browser back here with `#token=<JWT>` in the URL fragment.
 *     The GoogleAuthCallback component reads the fragment, calls acceptToken,
 *     and replaces history to `/chat`.
 *
 *   - loginWithEmail: POST `/auth/email/send` with `origin: "web"` so the
 *     cloud emits an `https://chat.ai-cognit.com/auth/email/callback?token=…`
 *     magic link (rather than the desktop's `cogni://`). When the user clicks
 *     it, EmailAuthCallback exchanges the magic for a JWT via acceptMagic.
 *
 * The user sees:
 *   - Click "用 Google 登录"  → browser navigates to cloud → consent →
 *     bounces back to /auth/google/callback → flashes "正在登录…" → /chat.
 *   - Click "发送登录链接"     → Login flips to "已发送…" → user opens link
 *     in mail client → lands on /auth/email/callback → "正在登录…" → /chat.
 */
export function useAuthWeb() {
  const { t } = useTranslation();
  const core = useAuthCore(api);

  const loginWithGoogle = () => {
    window.location.href = `${api.cloudUrl}/auth/google/start?origin=web`;
  };

  const loginWithEmail = async (email: string): Promise<void> => {
    await api.sendMagicLink(email, "web");
  };

  // Email+password. Login redeems a JWT inline (acceptToken); register / reset
  // only kick off an email — the JWT comes later when the user clicks the link
  // (handled by PasswordVerifyCallback / PasswordResetCallback).
  const passwordLogin = async (email: string, password: string): Promise<void> => {
    try {
      const { token } = await api.passwordLogin(email, password);
      core.acceptToken(token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new Error(t("auth.errors.invalidCredentials"));
      if (e instanceof ApiError && e.status === 429) throw new Error(t("auth.errors.tooManyAttempts"));
      throw new Error(t("auth.errors.network"));
    }
  };
  const passwordRegister = async (email: string, password: string): Promise<void> => {
    await api.passwordRegister(email, password, "web");
  };
  const passwordResetRequest = async (email: string): Promise<void> => {
    await api.passwordResetRequest(email, "web");
  };

  return {
    ...core,
    loginWithGoogle, loginWithEmail,
    passwordLogin, passwordRegister, passwordResetRequest,
  };
}
