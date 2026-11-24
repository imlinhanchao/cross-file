/**
 * Self-hosted signaling entry point (`infra/**`, docs/02 §7, docs/03 M4).
 *
 * This is the container's CMD. It differs from `packages/signaling/src/dev.ts` in exactly one
 * way: it honours `HOST` (default `0.0.0.0`) so the process is reachable through a published
 * Docker port. `dev.ts` calls `createSignalingServer({ port })` and therefore binds the server's
 * `DEFAULT_HOST` (`127.0.0.1`), which only works when a dev proxy is on the same host and cannot
 * be reached through container NAT.
 *
 * Everything else (port, TURN_URIS/TURN_SECRET parsing, single startup log line, signal
 * handling, zero-storage behaviour) mirrors dev.ts on purpose: the production path must exercise
 * the same code, not a fork of it. Keep the two files in sync; a future root-config change can
 * make dev.ts read HOST and delete this file (reported to the Lead, not changed here because
 * `packages/**` is outside this task's write scope).
 */
import {
  createSignalingServer,
  type TurnOptions,
} from "../../packages/signaling/src/index.js";
import { logError } from "../../packages/signaling/src/log.js";

const parsedPort = Number.parseInt(process.env.PORT ?? "8787", 10);
const port = Number.isFinite(parsedPort) ? parsedPort : 8787;
const host = process.env.HOST?.trim() || "0.0.0.0";

const uris = (process.env.TURN_URIS ?? "")
  .split(",")
  .map((uri) => uri.trim())
  .filter((uri) => uri.length > 0);
const secret = process.env.TURN_SECRET;
const turn: TurnOptions | undefined =
  uris.length > 0 && secret ? { uris, secret } : undefined;

const server = createSignalingServer({ port, host, ...(turn ? { turn } : {}) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}

server
  .start()
  .then(({ port: activePort }) => {
    // docs/02 §7: exactly one startup line on stdout, and no request logs after it.
    console.log(
      `[crossfile-signaling] listening on ws://${host}:${activePort}/v1/ws`,
    );
  })
  .catch((error: unknown) => {
    logError("startup", error);
    process.exitCode = 1;
  });
