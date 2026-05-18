import type { ThreadSummary, ThreadDetail, HostRegistration } from "@cogni/contract";

/**
 * Thrown by `ApiClient.*` methods on a non-2xx cloud response. `status` lets
 * callers react — e.g. drop back to the login screen on 401 (revoked session).
 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiConfig {
  cloudUrl: string;
  /** Read fresh on every request so token rotations (re-login) are picked up automatically. */
  getToken: () => string | null;
}

export interface HostInfo {
  id: string;
  name: string;
  status: string;
  lastSeen?: string | null;
}

export interface DeviceRow {
  id: string;
  deviceName: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

export interface IdentityRow {
  userId: string;
  kind: string;
  sub: string;
}

/**
 * Platform-agnostic transport. Desktop and web each construct one in their
 * own bootstrap (`apps/desktop/src/api.ts`, `apps/web/src/api.ts`) with a
 * `getToken` that reads from localStorage.
 *
 * No token is threaded through call arguments — the client reads
 * `cfg.getToken()` lazily, so a fresh login (which writes a new token to
 * localStorage) is picked up by the next call without re-wiring.
 */
export class ApiClient {
  constructor(private readonly cfg: ApiConfig) {}

  get cloudUrl(): string { return this.cfg.cloudUrl; }
  get wsUrl(): string { return this.cfg.cloudUrl.replace(/^http/, "ws"); }

  /** `?token=<jwt>` suffix for browser WebSocket URLs (which can't send custom headers). */
  wsTokenQuery(): string {
    const t = this.cfg.getToken();
    return t ? `?token=${encodeURIComponent(t)}` : "";
  }

  private authHeaders(extra?: Record<string, string>): HeadersInit {
    const t = this.cfg.getToken();
    return {
      "Content-Type": "application/json",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...extra,
    };
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new ApiError(res.status, `${init.method ?? "GET"} ${url} → ${res.status}`);
    }
    return (await res.json()) as T;
  }

  // ─── Threads ──────────────────────────────────────────────────────────
  listThreads = (): Promise<ThreadSummary[]> =>
    this.request(`${this.cloudUrl}/api/threads`, { headers: this.authHeaders() });

  createThread = (): Promise<ThreadSummary> =>
    this.request(`${this.cloudUrl}/api/threads`, { method: "POST", headers: this.authHeaders() });

  getThread = (id: string): Promise<ThreadDetail> =>
    this.request(`${this.cloudUrl}/api/threads/${id}`, { headers: this.authHeaders() });

  // ─── Hosts ────────────────────────────────────────────────────────────
  listHosts = (): Promise<HostInfo[]> =>
    this.request(`${this.cloudUrl}/api/hosts`, { headers: this.authHeaders() });

  createHost = (name: string): Promise<HostRegistration> =>
    this.request(`${this.cloudUrl}/api/hosts`, {
      method: "POST", headers: this.authHeaders(), body: JSON.stringify({ name }),
    });

  renameHost = (id: string, name: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/hosts/${id}`, {
      method: "PATCH", headers: this.authHeaders(), body: JSON.stringify({ name }),
    });

  removeHost = (id: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/hosts/${id}`, {
      method: "DELETE", headers: this.authHeaders(),
    });

  // ─── Devices (auth_sessions) ──────────────────────────────────────────
  listDevices = (): Promise<DeviceRow[]> =>
    this.request(`${this.cloudUrl}/api/devices`, { headers: this.authHeaders() });

  revokeDevice = (id: string): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/api/devices/${id}`, {
      method: "DELETE", headers: this.authHeaders(),
    });

  // ─── Identities ───────────────────────────────────────────────────────
  listIdentities = (): Promise<IdentityRow[]> =>
    this.request(`${this.cloudUrl}/api/identities`, { headers: this.authHeaders() });

  deleteIdentity = (kind: string, sub: string): Promise<{ ok: true }> =>
    this.request(
      `${this.cloudUrl}/api/identities/${kind}/${encodeURIComponent(sub)}`,
      { method: "DELETE", headers: this.authHeaders() },
    );

  // ─── Auth (magic-link) ────────────────────────────────────────────────
  /**
   * `origin` controls which URL the cloud puts in the email body —
   * `cogni://auth?magic=…` for desktop, `${webUrl}/auth/email/callback?token=…`
   * for web. UI feedback: Login flips to "已发送…" with 60s resend cooldown
   * regardless of whether the email is known (anti-enumeration).
   */
  sendMagicLink = (email: string, origin: "desktop" | "web"): Promise<{ ok: true }> =>
    this.request(`${this.cloudUrl}/auth/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, origin }),
    });

  /**
   * Exchange a magic token (delivered via cogni:// deep link on desktop or
   * via the SPA route handler on web) for a 30-day JWT.
   */
  redeemMagic = (magic: string): Promise<{ token: string }> =>
    this.request(`${this.cloudUrl}/auth/email/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magic }),
    });
}
