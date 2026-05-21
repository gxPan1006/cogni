import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Pure-browser SPA. No Tauri concerns here — the dev server just needs a
// stable port (the cloud's CORS allowlist + Google OAuth redirect_uri are
// registered against 5173 / chat.ai-cognit.com).
export default defineConfig({
  plugins: [
    react(),
    // PWA: makes the web app installable to the home screen (full-screen, own
    // icon) on iOS 16.4+ / Android. Phase 1 = installable shell only; push
    // notifications come later (needs cloud-side web-push + VAPID).
    VitePWA({
      // injectManifest: we hand-write the service worker (src/sw.ts) so it can
      // host `push` / `notificationclick` handlers for Web Push. The plugin
      // injects only the precache manifest into it. (generateSW can't host
      // custom handlers.) The SW still self.skipWaiting()+clientsClaim() so a
      // new deploy never pins users to a stale bundle — the web analogue of the
      // "stale Cogni.app / orphaned process" trap in MEMORY.md.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png"],
      injectManifest: {
        // Precache the build output. Cloud API/WS traffic (different origin) is
        // never cached — the SW has no runtime caching routes for it.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
      },
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
      // Let the SW work in `vite dev` so we can test install/offline locally
      // without a production build.
      devOptions: { enabled: true },
    }),
  ],
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
