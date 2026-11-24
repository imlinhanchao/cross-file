import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { useApp } from "./store.js";
import { markNativeShell } from "./lib/native.js";
import "./styles/index.css";

// Must run before any controller constructs its capabilities (Tauri shell only).
markNativeShell();

// Test hook: Playwright reads this to assert hashes/phases without scraping the DOM.
const target = globalThis as { __crossfile?: Record<string, unknown> };
target.__crossfile = {
  ...(target.__crossfile ?? {}),
  snapshot: () => useApp.getState(),
};

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<App />);
