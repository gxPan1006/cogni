/// <reference lib="webworker" />
/**
 * Custom service worker (vite-plugin-pwa `injectManifest` strategy).
 *
 * Phase 1 duties (was generateSW before): precache the build output for an
 * installable, offline-capable shell, and take over immediately on update so
 * users never get pinned to a stale bundle.
 *
 * Phase 2 duties (why we hand-write it now): handle `push` events — the OS
 * delivers these even when the PWA is closed — and `notificationclick` to focus
 * / open the app at the right place. generateSW can't host custom handlers, so
 * we own the SW and let the plugin inject only the precache manifest.
 */
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { clientsClaim } from "workbox-core";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

self.addEventListener("push", (event) => {
  // The cloud sends a JSON payload (push/notifier.ts). Be defensive: a push
  // with no/garbled data still shows a generic notification rather than
  // throwing (which would drop it silently).
  let payload: PushPayload = { title: "Cogni", body: "" };
  try {
    if (event.data) payload = { ...payload, ...(event.data.json() as PushPayload) };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/pwa-192.png",
      badge: "/pwa-192.png",
      tag: payload.tag,
      data: { url: payload.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data as { url?: string } | null)?.url ?? "/";

  // Focus an already-open Cogni window if there is one (and navigate it),
  // otherwise open a fresh one. This is the expected "tap the notification →
  // jump straight to the task" behaviour.
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client && targetUrl !== "/") {
            await (client as WindowClient).navigate(targetUrl).catch(() => {});
          }
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
