import { ApiClient, ApiError } from "@cogni/ui";
import type { HostInfo } from "@cogni/ui";

const CLOUD_URL = import.meta.env.VITE_CLOUD_URL ?? "http://localhost:8787";
const TOKEN_KEY = "cogni_token";

/**
 * Desktop's ApiClient instance. `getToken` reads the JWT fresh from
 * localStorage on every call so a re-login (which writes a new token) is
 * picked up automatically without re-wiring.
 */
export const api = new ApiClient({
  cloudUrl: CLOUD_URL,
  getToken: () => localStorage.getItem(TOKEN_KEY),
});

export { ApiError };
export type { HostInfo };
