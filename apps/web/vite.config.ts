import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Pure-browser SPA. No Tauri concerns here — the dev server just needs a
// stable port (the cloud's CORS allowlist + Google OAuth redirect_uri are
// registered against 5173 / chat.ai-cognit.com).
export default defineConfig({
  plugins: [
    react(),
    // SELF-DESTROYING service worker. The precaching SW caused recurring pain on
    // iOS: Cloudflare cached sw.js (stale app), and a reload loop that the SW's
    // own caching made impossible to push a fix into. `selfDestroying` ships a
    // tiny SW that unregisters itself + clears all caches on every client that
    // still has the old one — including a looping one, because it's tiny and
    // activates instantly. Result: the app reverts to a plain web page (no SW,
    // no offline cache, no update loop) that always loads fresh from the network.
    // It stays installable to the home screen via the manifest below.
    // NOTE: Web Push needs a service worker, so push is disabled while this is
    // on. Re-introduce a real SW deliberately once the app is stable again.
    VitePWA({
      selfDestroying: true,
      registerType: "autoUpdate",
      manifest: {
        name: "Cogni",
        short_name: "Cogni",
        description: "Brain in the cloud, hands on your machine.",
        lang: "en",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#faf8f3",
        theme_color: "#faf8f3",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
