import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@cogni/ui"; // side-effect: init i18next (language) before first render
import App from "./App.js";
import { InstallPrompt } from "./InstallPrompt.js";
import { NotificationsPrompt } from "./NotificationsPrompt.js";

// Global stylesheet chain — order matters (matches apps/desktop):
//   1. tokens (CSS variables — colors, type, radii, shadows; light + dark)
//   2. base   (reset + body + reusable primitives — consume tokens)
// Per-component CSS (sidebar.css, conversation.css, ...) is imported by each
// @cogni/ui component module, so component-level styles co-locate with code.
import "./styles/tokens.css";
import "./styles/base.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <InstallPrompt />
      <NotificationsPrompt />
    </BrowserRouter>
  </StrictMode>,
);
