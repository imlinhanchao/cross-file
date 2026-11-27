import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const APP_PORT = Number(process.env.E2E_PORT ?? 5174);
const APP_ORIGIN = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${APP_PORT}`;
const MANAGE_SERVERS = process.env.E2E_NO_WS !== "1";
const SIGNALING_PORT = Number(process.env.E2E_SIGNALING_PORT ?? 8790);
/**
 * Which signaling server the suite talks to:
 *  - `node` (default): the TypeScript server through `tsx packages/signaling/src/dev.ts`;
 *  - `go`: the production Go binary built by `apps/signaling-go/build.sh` (single static
 *    binary with the web app and an in-process TURN server embedded).
 * Vite still serves the web app in both modes; the Go binary only has to answer `/v1/ws`
 * on SIGNALING_PORT for the e2e suite.
 */
const E2E_SERVER = process.env.E2E_SERVER ?? "node";
const GO_ROOT = resolve("apps/signaling-go");
const GO_BUILD = resolve(GO_ROOT, "build.sh");
const GO_BIN = resolve(GO_ROOT, "bin/crossfile-signaling");

if (E2E_SERVER !== "node" && E2E_SERVER !== "go") {
  throw new Error(
    `E2E_SERVER must be "node" or "go" (got "${E2E_SERVER}"); unset it for the default Node server`,
  );
}

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
 * TURN passthrough shared by both signaling modes. With E2E_RELAY=1 the suite
 * forces ICE onto TURN (`tests/e2e/ac2-relay.spec.ts`); the Go binary starts its
 * in-process TURN listener from these variables, the Node server only issues
 * credentials for an external coturn. Only variables that are actually set are
 * forwarded so each mode keeps its own defaults.
 */
function relayEnv(): Record<string, string> {
  if (process.env.E2E_RELAY !== "1") return {};
  const env: Record<string, string> = {
    TURN_URIS: process.env.TURN_URIS ?? "",
    TURN_SECRET: process.env.TURN_SECRET ?? "",
  };
  for (const key of [
    "TURN_EXTERNAL_IP",
    "TURN_LISTEN_PORT",
    "TURN_MIN_PORT",
    "TURN_MAX_PORT",
  ] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The Go binary runs TURN in-process and refuses to start when TURN_SECRET is set but
  // TURN_EXTERNAL_IP is missing. E2E browsers run on the same host, so loopback is the
  // correct relay address unless the caller overrides it (LAN/phone testing).
  if (E2E_SERVER === "go" && env.TURN_EXTERNAL_IP === undefined) {
    env.TURN_EXTERNAL_IP = "127.0.0.1";
  }
  return env;
}

/** Build + run the Go binary; `SKIP_WEB=1` because Vite serves the app in e2e. */
function goSignalingCommand(): string {
  return [
    `SKIP_WEB=1 bash ${JSON.stringify(GO_BUILD)}`,
    `PORT=${SIGNALING_PORT} HOST=127.0.0.1 RATE_LIMIT_MAX=100000 ${JSON.stringify(GO_BIN)}`,
  ].join(" && ");
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
        E2E_SERVER === "go"
          ? {
              // First run compiles pion + the binary; the Go build cache makes later runs
              // cheap, but a cold CI runner needs more than the Node branch's 60 s.
              command: goSignalingCommand(),
              env: serverEnv({
                // The whole suite talks from 127.0.0.1 to one signaling process; the
                // production per-IP budget would throttle the run (the Go server reads
                // the same test-only escape hatch as dev.ts).
                RATE_LIMIT_MAX: "100000",
                ...relayEnv(),
              }),
              port: SIGNALING_PORT,
              reuseExistingServer: !process.env.CI,
              gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
              timeout: 300_000,
            }
          : {
              command: `PORT=${SIGNALING_PORT} ./node_modules/.bin/tsx packages/signaling/src/dev.ts`,
              env: serverEnv({
                // The whole suite talks from 127.0.0.1 to one signaling process; the
                // production per-IP budget would throttle the run (dev.ts reads these).
                RATE_LIMIT_MAX: "100000",
                ...relayEnv(),
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
