/**
 * Dev entry point: `pnpm --filter @crossfile/signaling dev` (tsx watch).
 *
 * Environment: PORT (default 8787), TURN_URIS (comma separated), TURN_SECRET.
 * Per docs/02 §7 the process prints exactly one startup line and no request logs.
 */
import { createSignalingServer, type TurnOptions } from "./index.js";
import { logError } from "./log.js";

const parsedPort = Number.parseInt(process.env.PORT ?? "8787", 10);
const port = Number.isFinite(parsedPort) ? parsedPort : 8787;
const uris = (process.env.TURN_URIS ?? "")
  .split(",")
  .map((uri) => uri.trim())
  .filter((uri) => uri.length > 0);
const secret = process.env.TURN_SECRET;
const turn: TurnOptions | undefined = uris.length > 0 && secret ? { uris, secret } : undefined;

const server = createSignalingServer({ port, ...(turn ? { turn } : {}) });

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
