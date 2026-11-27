/**
 * PM2 process definition for the Go single-binary deployment (docs/self-host.md).
 *
 * This file ships inside `crossfile-signaling-<version>-linux-x64.tar.gz` as
 * `ecosystem.config.cjs`. The release directory contains exactly:
 *
 *   crossfile-signaling   the static Go binary: HTTP + SPA + /v1/ws + in-process TURN
 *   ecosystem.config.cjs  this file
 *   VERSION               commit / version / build timestamp
 *
 * There is no Node runtime, no `public/` directory and no `server.cjs`: the web app is
 * embedded into the binary at build time, so `interpreter: "none"` runs it directly.
 * Environment values come from the server-side `shared/.env`, which deploy.yml sources
 * before `pm2 start ... --update-env`; every value is forwarded explicitly so a PM2
 * daemon started from another shell cannot silently drop TURN configuration.
 */
const path = require("node:path");

const binary = path.join(__dirname, "crossfile-signaling");

const env = {
  HOST: process.env.HOST || "0.0.0.0",
  PORT: process.env.PORT || "8788",
};
// Forward the rest only when the operator actually set them: empty strings are not the same as
// "unset" (MAX_MEMBERS empty means "server default", TURN_URIS empty means "no TURN offered",
// docs/02 §6.7), and the Go binary's own defaults (3478 / 49160–49200) are the documented ones.
for (const key of [
  "MAX_MEMBERS",
  "TURN_URIS",
  "TURN_SECRET",
  "TURN_EXTERNAL_IP",
  "TURN_LISTEN_PORT",
  "TURN_MIN_PORT",
  "TURN_MAX_PORT",
]) {
  const value = process.env[key];
  if (value !== undefined && value !== "") env[key] = value;
}

const app = {
  name: "crossfile-signaling",
  cwd: __dirname,
  script: binary,
  // The artifact is an executable, not a JS entry point: PM2 must exec it as-is.
  interpreter: "none",
  instances: 1,
  exec_mode: "fork",
  autorestart: true,
  max_memory_restart: "512M",
  // Go handles SIGTERM (close WS connections, stop TURN, exit) well under this.
  kill_timeout: 10_000,
  time: true,
  merge_logs: true,
  env,
};

// Keep logs next to the releases when the deploy script provides a directory.
if (process.env.PM2_LOG_DIR) {
  app.out_file = path.join(process.env.PM2_LOG_DIR, "signaling.out.log");
  app.error_file = path.join(process.env.PM2_LOG_DIR, "signaling.err.log");
}

module.exports = { apps: [app] };
