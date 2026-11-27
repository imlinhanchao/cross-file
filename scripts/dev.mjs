#!/usr/bin/env node
/**
 * `pnpm dev`: run the Go signaling binary (:8788) and the Vite web dev server (:5173).
 *
 * The Node signaling server was removed (docs/05 §7.5); `apps/signaling-go` is the only
 * backend. Vite proxies `/v1/ws` to 8788 (apps/web/vite.config.ts), so the browser talks to a
 * single dev origin. Ctrl-C / SIGTERM stops both children and exits with the first failure.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SIGNALING_PORT = process.env.PORT ?? "8788";

/** Build the Go binary once (SKIP_WEB: Vite serves the app in dev), then run it in the foreground. */
const signalCommand = [
  "SKIP_WEB=1 bash apps/signaling-go/build.sh",
  `PORT=${SIGNALING_PORT} HOST=127.0.0.1 apps/signaling-go/bin/crossfile-signaling`,
].join(" && ");

const children = [];
let stopping = false;

function start(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    stopping = true;
    for (const other of children) {
      if (other !== child && other.exitCode === null) other.kill("SIGTERM");
    }
    const how = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[dev] ${label} exited (${how}); stopping the other process`);
    process.exit(code ?? 1);
  });
  return child;
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

// Signaling first: the binary build + listener must be up before the web app proxies to it.
// Vite tolerates a cold signaling port (the proxy connects on demand), so starting both in
// parallel keeps `pnpm dev` snappy; the build is the slow part, not the listener.
start("signaling", "bash", ["-c", signalCommand]);
start("web", "pnpm", ["--filter", "@crossfile/web", "dev"], {
  CROSSFILE_SIGNALING_URL: `ws://127.0.0.1:${SIGNALING_PORT}`,
});
