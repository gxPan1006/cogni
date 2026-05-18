import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pure-browser SPA. No Tauri concerns here — the dev server just needs a
// stable port (the cloud's CORS allowlist + Google OAuth redirect_uri are
// registered against 5173 / chat.ai-cognit.com).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
