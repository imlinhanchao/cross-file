/**
 * Production build for the self-hosted signaling image (`infra/**`).
 *
 * Why bundling instead of running TypeScript directly in the container:
 *  - `tsx` transpiles on the fly and writes its transformed modules into `$TMPDIR/tsx-<uid>/`,
 *    which is a real file write by the signaling process. That breaks the zero-storage
 *    requirement (docs/02 §7, docs/01 AC8) and fails inside a read-only container rootfs.
 *  - A plain `node server.cjs` from a single bundled file opens nothing writable at runtime.
 *
 * esbuild is not a direct dependency of any workspace package; it comes with `tsx` (a
 * devDependency of @crossfile/signaling). Resolving it through tsx's own package directory keeps
 * the Docker install to `pnpm install --filter @crossfile/signaling...` and needs no new
 * dependency or root-config change.
 *
 * Run: node infra/signaling/build.mjs [repo-root]
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.argv[2] ?? join(here, "..", ".."));
const signalingDir = join(repoRoot, "packages", "signaling");

const tsxManifest = require.resolve("tsx/package.json", { paths: [signalingDir] });
const esbuild = createRequire(tsxManifest)("esbuild");

const outfile = join(here, "build", "server.cjs");
mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [join(here, "entry.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // ws optionally `require()`s native accelerators; they are not installed and ws falls back to
  // the JavaScript implementation, which is what this image runs.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});

console.log(`[build] wrote ${outfile}`);
