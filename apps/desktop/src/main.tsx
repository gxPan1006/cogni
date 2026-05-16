import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Global stylesheet chain — order matters:
//   1. tokens (defines all CSS variables)
//   2. base   (reset + body + reusable primitives — consume tokens)
//   3. layout (Shell layout grid — consumes both)
// Per-component CSS (sidebar.css, conversation.css, etc.) is imported by the
// owning component module so component-level styles co-locate with their code.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
