/**
 * Client-side Web Push wiring for the PWA.
 *
 * Flow: fetch the cloud's public VAPID key → ask the OS for notification
 * permission → `pushManager.subscribe` against our service worker → POST the
 * resulting endpoint to the cloud so it can push to this device later.
 *
 * All cloud calls reuse the same base URL + bearer token convention as
 * api.ts (VITE_CLOUD_URL + the `cogni_token` localStorage key).
 */
const CLOUD_URL = import.meta.env.VITE_CLOUD_URL ?? "http://localhost:8787";
const TOKEN_KEY = "cogni_token";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Browser capability check — push needs all three APIs. */
export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}

/** null ⇒ push not configured server-side (route 503) ⇒ hide the UI. */
export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch(`${CLOUD_URL}/api/push/vapid-public-key`, { headers: authHeaders() });
    if (!res.ok) return null;
    const body = (await res.json()) as { publicKey?: string };
    return body.publicKey ?? null;
  } catch {
    return null;
  }
}

/** Already subscribed on this browser? (So we don't re-prompt.) */
export async function hasPushSubscription(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) !== null;
}

/**
 * Request permission + subscribe + register with the cloud. Returns true on
 * success. `locale` is stored server-side so notification text matches this
 * device's language.
 */
export async function enablePush(locale: string): Promise<boolean> {
  if (!isPushSupported()) return false;

  const publicKey = await fetchVapidPublicKey();
  if (!publicKey) return false;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const reg = await navigator.serviceWorker.ready;
  // Reuse an existing subscription if present; otherwise create one.
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;

  const res = await fetch(`${CLOUD_URL}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      locale,
    }),
  });
  return res.ok;
}

/** Turn push off: unsubscribe locally + tell the cloud to forget the endpoint. */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch(`${CLOUD_URL}/api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}

/** VAPID keys are base64url; PushManager wants a Uint8Array. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
