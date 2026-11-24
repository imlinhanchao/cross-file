/**
 * Dev entry point: `pnpm --filter @crossfile/signaling dev` (tsx watch).
 *
 * Environment: PORT (default 8788 — 8787 is commonly taken on dev machines), HOST,
 * TURN_URIS (comma separated), TURN_SECRET.
 * Per docs/02 §7 the process prints exactly one startup line and no request logs.
 */
import { createSignalingServer, type TurnOptions } from "./index.js";
import { logError } from "./log.js";

const parsedPort = Number.parseInt(process.env.PORT ?? "8788", 10);
const port = Number.isFinite(parsedPort) ? parsedPort : 8788;
const uris = (process.env.TURN_URIS ?? "")
  .split(",")
  .map((uri) => uri.trim())
  .filter((uri) => uri.length > 0);
const secret = process.env.TURN_SECRET;
const turn: TurnOptions | undefined = uris.length > 0 && secret ? { uris, secret } : undefined;

// HOST lets the container bind 0.0.0.0 (a published port cannot reach 127.0.0.1).
const host = process.env.HOST?.trim();
const server = createSignalingServer({ port, ...(host ? { host } : {}), ...(turn ? { turn } : {}) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}

server
  .start()
  .then(({ port: activePort }) => {
    console.log(`[crossfile-signaling] listening on ws://127.0.0.1:${activePort}/v1/ws`);
  })
  .catch((error: unknown) => {
    logError("startup", error);
    process.exitCode = 1;
  });
