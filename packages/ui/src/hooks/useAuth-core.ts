import { useState, useCallback } from "react";
import type { ApiClient } from "../transport/api.js";

const TOKEN_KEY = "cogni_token";

/**
 * Platform-agnostic token state. Desktop wraps it with Tauri deep-link
 * intake (`cogni://auth?token=…` or `?magic=…`). Web wraps it with
 * redirect-callback intake (`/auth/google/callback#token=…` or
 * `/auth/email/callback?token=…`).
 *
 * Both wrappers ultimately call `acceptToken(jwt)` (Google + dev-token paths
 * — the cloud already gave us a JWT) or `acceptMagic(magic)` (email path —
 * we still need to redeem the one-time magic token for a JWT).
 */
export function useAuthCore(api: ApiClient) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  const acceptToken = useCallback((jwt: string) => {
    localStorage.setItem(TOKEN_KEY, jwt);
    setToken(jwt);
  }, []);

  const acceptMagic = useCallback(async (magic: string) => {
    const { token: jwt } = await api.redeemMagic(magic);
    acceptToken(jwt);
  }, [api, acceptToken]);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  return { token, acceptToken, acceptMagic, logout };
}
