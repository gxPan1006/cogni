/**
 * Make PWA updates apply on their own, so a new deploy doesn't require deleting
 * + reinstalling the home-screen app.
 *
 * iOS only checks for a new service worker lazily, which is why an installed
 * PWA kept showing stale UI after a deploy. We nudge it: every time the app
 * returns to the foreground we call registration.update(); when a new worker
 * takes control (our SW uses skipWaiting + clientsClaim) the `controllerchange`
 * event fires and we reload once to pick up the fresh assets.
 */
export function setupSwAutoUpdate(): void {
  if (!("serviceWorker" in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return; // guard against a reload loop
    reloading = true;
    window.location.reload();
  });

  const check = () => {
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.update())
      .catch(() => {});
  };

  // Foreground is the moment the user reopens the PWA — the right time to look
  // for a newer version without interrupting active use.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  check();
}
