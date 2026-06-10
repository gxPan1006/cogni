import { ApiClient, ApiError } from "@cogni/ui";
import type { HostInfo } from "@cogni/ui";

const CLOUD_URL = import.meta.env.VITE_CLOUD_URL ?? "http://localhost:8787";
const TOKEN_KEY = "cogni_token";

/**
 * Web's ApiClient instance. Mirrors apps/desktop/src/api.ts exactly —
 * `getToken` reads the JWT fresh from localStorage on every call so a
 * re-login (which writes a new token via useAuthCore.acceptToken /
 * acceptMagic) is picked up automatically without re-wiring.
 *
 * The only meaningful difference vs desktop is VITE_CLOUD_URL's default
 * production target (your-cogni-cloud.example.com instead of localhost) — see
 * apps/web/.env.production.
 */
export const api = new ApiClient({
  cloudUrl: CLOUD_URL,
  getToken: () => localStorage.getItem(TOKEN_KEY),
});

export { ApiError };
export type { HostInfo };
