import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";

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
    </BrowserRouter>
  </StrictMode>,
);
