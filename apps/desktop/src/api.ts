import type { ThreadSummary, ThreadDetail, HostRegistration } from "@cogni/contract";

const CLOUD_URL = import.meta.env.VITE_CLOUD_URL ?? "http://localhost:8787";
const WS_URL = CLOUD_URL.replace(/^http/, "ws");

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

export interface HostInfo { id: string; name: string; status: string }

/**
 * Thrown by `api.*` methods on a non-2xx cloud response. `status` lets callers
 * react — e.g. drop back to the login screen on 401.
 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new ApiError(res.status, `${init.method ?? "GET"} ${url} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  cloudUrl: CLOUD_URL,
  wsUrl: WS_URL,
  listThreads(token: string): Promise<ThreadSummary[]> {
    return request(`${CLOUD_URL}/api/threads`, { headers: headers(token) });
  },
  createThread(token: string): Promise<ThreadSummary> {
    return request(`${CLOUD_URL}/api/threads`, { method: "POST", headers: headers(token) });
  },
  getThread(token: string, id: string): Promise<ThreadDetail> {
    return request(`${CLOUD_URL}/api/threads/${id}`, { headers: headers(token) });
  },
  listHosts(token: string): Promise<HostInfo[]> {
    return request(`${CLOUD_URL}/api/hosts`, { headers: headers(token) });
  },
  createHost(token: string, name: string): Promise<HostRegistration> {
    return request(`${CLOUD_URL}/api/hosts`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ name }),
    });
  },
};
