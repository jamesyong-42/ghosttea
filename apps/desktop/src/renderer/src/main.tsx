import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GhostteaProvider } from "@vibecook/ghosttea-react";
import { App } from "./App";
import { terminalRuntime } from "./terminal";
import "@vibecook/ghosttea-react/styles.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GhostteaProvider runtime={terminalRuntime}>
      <App />
    </GhostteaProvider>
  </StrictMode>,
);
