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

if (import.meta.env.DEV) {
  // DEV-ONLY: surface uncaught errors to the cross-machine diagnostics channel.
  const target = globalThis as { __crossfileLastError?: string };
  globalThis.addEventListener?.("error", (event) => {
    target.__crossfileLastError = `${event.message}`;
  });
  globalThis.addEventListener?.("unhandledrejection", (event) => {
    target.__crossfileLastError = `unhandled: ${String(event.reason)}`;
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<App />);
