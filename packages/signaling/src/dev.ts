/**
 * Dev entry point: `pnpm --filter @crossfile/signaling dev` (tsx watch).
 *
 * Environment: PORT (default 8788 — 8787 is commonly taken on dev machines), HOST,
 * STATIC_DIR (optional built web app for single-origin production),
 * TURN_URIS (comma separated), TURN_SECRET, MAX_MEMBERS (room capacity excluding the
 * admin; legacy MAX_GUESTS also accepted), RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS
 * (test-only escape hatch for the per-IP signaling budget).
 * Per docs/02 §7 the process prints exactly one startup line and no request logs.
 */
import { createSignalingServer, type TurnOptions } from "./index.js";
import { parseMaxMembers } from "./config.js";
import { logError } from "./log.js";

const parsedPort = Number.parseInt(process.env.PORT ?? "8788", 10);
const port = Number.isFinite(parsedPort) ? parsedPort : 8788;
const uris = (process.env.TURN_URIS ?? "")
  .split(",")
  .map((uri) => uri.trim())
  .filter((uri) => uri.length > 0);
const secret = process.env.TURN_SECRET;
const turn: TurnOptions | undefined =
  uris.length > 0 && secret ? { uris, secret } : undefined;

// HOST lets the container bind 0.0.0.0 (a published port cannot reach 127.0.0.1).
const host = process.env.HOST?.trim();
const staticDir = process.env.STATIC_DIR?.trim();

// Room capacity excluding the admin (docs/01 D6): official instance 2, self-hosted 4.
// A malformed value is a deployment mistake — fail before listening, not after.
function resolveMaxMembers(): number | undefined {
  try {
    return parseMaxMembers(process.env);
  } catch (error) {
    logError("config", error);
    process.exit(1);
  }
}
const maxMembers = resolveMaxMembers();
// Test/dev escape hatch: Playwright runs every spec from 127.0.0.1 against one
// signaling process, so the production per-IP budget (120 msg / 60 s) would
// throttle a full suite. Unset keeps the production policy untouched.
const rateLimitMax = Number.parseInt(process.env.RATE_LIMIT_MAX ?? "", 10);
const rateLimitWindowMs = Number.parseInt(
  process.env.RATE_LIMIT_WINDOW_MS ?? "",
  10,
);
const rateLimit =
  Number.isFinite(rateLimitMax) && rateLimitMax > 0
    ? {
        windowMs:
          Number.isFinite(rateLimitWindowMs) && rateLimitWindowMs > 0
            ? rateLimitWindowMs
            : 60_000,
        max: rateLimitMax,
      }
    : undefined;
const server = createSignalingServer({
  port,
  ...(host ? { host } : {}),
  ...(turn ? { turn } : {}),
  ...(staticDir ? { staticDir } : {}),
  ...(maxMembers ? { maxMembers } : {}),
  ...(rateLimit ? { rateLimit } : {}),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}

server
  .start()
  .then(({ port: activePort }) => {
    console.log(
      `[crossfile-signaling] listening on ws://127.0.0.1:${activePort}/v1/ws`,
    );
  })
  .catch((error: unknown) => {
    logError("startup", error);
    process.exitCode = 1;
  });
