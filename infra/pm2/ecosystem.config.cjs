/**
 * PM2 process definition for a Docker-less deployment (see docs/self-host.md).
 *
 * The release directory contains server.cjs (bundled signaling + static file server),
 * public/ (the built web app) and this file. Environment values are read from the
 * process environment, which the deploy script loads from the server-side
 * shared/.env before `pm2 startOrReload ... --update-env`.
 */
const path = require("node:path");

const app = {
  name: "crossfile-signaling",
  cwd: __dirname,
  script: path.join(__dirname, "server.cjs"),
  instances: 1,
  exec_mode: "fork",
  autorestart: true,
  max_memory_restart: "512M",
  kill_timeout: 10_000,
  time: true,
  merge_logs: true,
  env: {
    NODE_ENV: "production",
    HOST: process.env.HOST || "0.0.0.0",
    PORT: process.env.PORT || "8788",
    STATIC_DIR: path.join(__dirname, "public"),
    TURN_URIS: process.env.TURN_URIS || "",
    TURN_SECRET: process.env.TURN_SECRET || "",
  },
};

// Keep logs next to the releases when the deploy script provides a directory.
if (process.env.PM2_LOG_DIR) {
  app.out_file = path.join(process.env.PM2_LOG_DIR, "signaling.out.log");
  app.error_file = path.join(process.env.PM2_LOG_DIR, "signaling.err.log");
}

module.exports = { apps: [app] };
