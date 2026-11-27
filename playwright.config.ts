import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const APP_PORT = Number(process.env.E2E_PORT ?? 5174);
const APP_ORIGIN = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${APP_PORT}`;
const MANAGE_SERVERS = process.env.E2E_NO_WS !== "1";
const SIGNALING_PORT = Number(process.env.E2E_SIGNALING_PORT ?? 8790);

/**
 * Some sandboxes block inotify, so `fs.watch()` throws EMFILE and Vite's dev
 * server (started by the Playwright `webServer`) aborts. The shim falls back to
 * stat polling only when the native watcher fails; on a normal host it is a
 * no-op. Set E2E_WATCH_FALLBACK=0 to opt out.
 */
const WATCH_FALLBACK = resolve("tests/e2e/fs-watch-fallback.cjs");
const WATCH_FALLBACK_NODE_OPTIONS =
  process.env.E2E_WATCH_FALLBACK !== "0" && existsSync(WATCH_FALLBACK)
    ? [process.env.NODE_OPTIONS, `--require ${WATCH_FALLBACK}`]
        .filter(Boolean)
        .join(" ")
    : process.env.NODE_OPTIONS;

function serverEnv(
  extra?: Record<string, string>,
): Record<string, string> | undefined {
  const env = { ...(extra ?? {}) };
  if (WATCH_FALLBACK_NODE_OPTIONS)
    env.NODE_OPTIONS = WATCH_FALLBACK_NODE_OPTIONS;
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * E2E harness. Chromium runs the *installed* Chrome (channel: "chrome") so the
 * engine matches the one the fact sheets measured; WebKit is downloaded per
 * `pnpm exec playwright install webkit` and covers the Safari engine locally.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // WebRTC resume/ICE timing on GitHub's runners is occasionally flaky; one retry keeps a
  // single transient failure from failing the whole gate (a real regression fails both).
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: APP_ORIGIN,
    // Only needed when running against the dev reverse proxy origin.
    ignoreHTTPSErrors: process.env.E2E_IGNORE_TLS === "1",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    // WebKit needs `pnpm exec playwright install webkit` + host deps (sudo).
    // Safari engine coverage runs on the mac-mini peer instead; enable locally
    // with E2E_WEBKIT=1 once the browser bundle is installed.
    ...(process.env.E2E_WEBKIT
      ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }]
      : []),
  ],
  webServer: MANAGE_SERVERS
    ? [
        {
          command: `PORT=${SIGNALING_PORT} ./node_modules/.bin/tsx packages/signaling/src/dev.ts`,
          env: serverEnv({
            // The whole suite talks from 127.0.0.1 to one signaling process; the
            // production per-IP budget would throttle the run (dev.ts reads these).
            RATE_LIMIT_MAX: "100000",
            ...(process.env.E2E_RELAY === "1"
              ? {
                  TURN_URIS: process.env.TURN_URIS ?? "",
                  TURN_SECRET: process.env.TURN_SECRET ?? "",
                }
              : {}),
          }),
          port: SIGNALING_PORT,
          reuseExistingServer: !process.env.CI,
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
          timeout: 60_000,
        },
        {
          command: `CROSSFILE_SIGNALING_URL=ws://127.0.0.1:${SIGNALING_PORT} ./node_modules/.bin/vite apps/web --host 0.0.0.0 --port ${APP_PORT} --strictPort`,
          env: serverEnv(),
          port: APP_PORT,
          reuseExistingServer: !process.env.CI,
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
          timeout: 90_000,
        },
      ]
    : undefined,
});
