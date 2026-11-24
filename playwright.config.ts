import { defineConfig, devices } from "@playwright/test";

const APP_PORT = Number(process.env.E2E_PORT ?? 5174);
const APP_ORIGIN = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${APP_PORT}`;
const MANAGE_SERVERS = process.env.E2E_NO_WS !== "1";
const SIGNALING_PORT = Number(process.env.E2E_SIGNALING_PORT ?? 8790);

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
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: APP_ORIGIN,
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
    ...(process.env.E2E_WEBKIT ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
  webServer: MANAGE_SERVERS ? [
    {
      command: `PORT=${SIGNALING_PORT} ./node_modules/.bin/tsx packages/signaling/src/dev.ts`,
      port: SIGNALING_PORT,
      reuseExistingServer: !process.env.CI,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: 60_000,
    },
    {
      command: `CROSSFILE_SIGNALING_URL=ws://127.0.0.1:${SIGNALING_PORT} ./node_modules/.bin/vite apps/web --host 0.0.0.0 --port ${APP_PORT} --strictPort`,
      port: APP_PORT,
      reuseExistingServer: !process.env.CI,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: 90_000,
    },
  ] : undefined,
});
