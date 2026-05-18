import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Global stylesheet chain — order matters:
//   1. tokens (defines all CSS variables — colors, type, radii, shadows; light + dark)
//   2. base   (reset + body + reusable primitives — consume tokens)
// Per-component CSS (sidebar.css, conversation.css, etc.) is imported by the
// owning component module so component-level styles co-locate with their code.
import "./styles/tokens.css";
import "./styles/base.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
