/**
 * Entry point for the SEA single binary (Node `--experimental-sea-config`).
 *
 * Same environment contract as `entry.ts` (PORT / HOST / TURN_URIS / TURN_SECRET and the
 * single startup log line), but the built web app is not read from `STATIC_DIR`: it is
 * embedded into the executable through SEA assets by `infra/signaling/build-sea.mjs`.
 *
 * Build: `node infra/signaling/build-sea.mjs [repo-root]` (see that file for the pipeline).
 * Run:   `PORT=8788 HOST=127.0.0.1 TURN_SECRET=... TURN_URIS=... ./crossfile-signaling`
 */
import { getAsset, isSea } from "node:sea";
import {
  createSignalingServer,
  type StaticSource,
  type TurnOptions,
} from "../../packages/signaling/src/index.js";
import { createMemorySource } from "../../packages/signaling/src/static.js";
import { logError } from "../../packages/signaling/src/log.js";

if (!isSea()) {
  logError(
    "sea",
    new Error(
      "this entry must run inside a Node SEA binary (build it with infra/signaling/build-sea.mjs)",
    ),
  );
  process.exit(1);
}

/** Load every `public/...` SEA asset into memory once, at startup. */
function loadEmbeddedWebApp(): StaticSource | undefined {
  let manifest: string[];
  try {
    manifest = JSON.parse(getAsset("assets-manifest.json", "utf8")) as string[];
  } catch (error) {
    logError("static", error);
    return undefined;
  }
  const files = new Map<string, Uint8Array>();
  for (const key of manifest) {
    if (!key.startsWith("public/")) continue;
    try {
      files.set(key.slice("public/".length), new Uint8Array(getAsset(key)));
    } catch (error) {
      logError("static", error);
    }
  }
  return createMemorySource(files);
}

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

const staticAssets = loadEmbeddedWebApp();
if (!staticAssets?.ready) {
  logError("static", new Error("embedded web app has no index.html"));
}

const server = createSignalingServer({
  port,
  host,
  ...(turn ? { turn } : {}),
  ...(staticAssets ? { staticAssets } : {}),
});

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
