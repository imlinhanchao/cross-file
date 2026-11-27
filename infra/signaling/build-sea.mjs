/**
 * Build the Node SEA single binary for the signaling server (`infra/signaling/sea-entry.ts`).
 *
 * Pipeline:
 *  1. esbuild bundles sea-entry.ts into one CommonJS file (same externals as build.mjs);
 *  2. every file under `apps/web/dist` becomes a SEA asset keyed `public/<relpath>`, plus
 *     `assets-manifest.json` listing those keys so the entry can load them at startup;
 *  3. `node --experimental-sea-config` produces the blob;
 *  4. `postject` injects the blob into a copy of the current Node executable.
 *
 * Do not strip the result: `strip` corrupts the injected SEA blob (the binary segfaults), so
 * the build keeps the ~123 MB unstripped Node executable on purpose.
 *
 * Prerequisites: `apps/web/dist` already built (`pnpm --filter @crossfile/web build`) and the
 * root `postject` devDependency installed (`pnpm install`). Node must be the same major version
 * that the binary will run (the binary is a copy of this Node, so no runtime install is needed).
 *
 * Run: `node infra/signaling/build-sea.mjs [repo-root]`
 * Output: `infra/signaling/build/crossfile-signaling` (not gzipped; the release workflow does it).
 *
 * The binary embeds the web app, so deploying it is "copy one file and run it" — no Node, no
 * `public/` directory, no `STATIC_DIR`. Environment: PORT / HOST / TURN_URIS / TURN_SECRET.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const repoRoot = resolve(
  args.find((arg) => !arg.startsWith("--")) ?? join(here, "..", ".."),
);
const webDist = join(repoRoot, "apps", "web", "dist");
const buildDir = join(here, "build");
const bundlePath = join(buildDir, "sea-entry.cjs");
const manifestPath = join(buildDir, "assets-manifest.json");
const seaConfigPath = join(buildDir, "sea-config.json");
const blobPath = join(buildDir, "sea-prep.blob");
const outfile = join(buildDir, "crossfile-signaling");
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

if (!statSync(join(webDist, "index.html"), { throwIfNoEntry: false })) {
  throw new Error(
    `missing ${join(webDist, "index.html")}; run \`pnpm --filter @crossfile/web build\` first`,
  );
}
mkdirSync(buildDir, { recursive: true });

// esbuild comes with tsx (a devDependency of @crossfile/signaling), exactly like build.mjs.
const signalingDir = join(repoRoot, "packages", "signaling");
const tsxManifest = require.resolve("tsx/package.json", {
  paths: [signalingDir],
});
const esbuild = createRequire(tsxManifest)("esbuild");

await esbuild.build({
  entryPoints: [join(here, "sea-entry.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // ws optionally `require()`s native accelerators; they are not installed and ws falls back
  // to the JavaScript implementation, which is what the binary runs.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});

// --- embed the built web app -------------------------------------------------
const assetFiles = walk(webDist);
const manifest = [];
const assets = {};
for (const file of assetFiles) {
  const relativePath = relative(webDist, file).split(sep).join("/");
  const key = `public/${relativePath}`;
  assets[key] = file;
  manifest.push(key);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
assets["assets-manifest.json"] = manifestPath;

writeFileSync(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      assets,
    },
    null,
    2,
  )}\n`,
);

// --- blob + injection --------------------------------------------------------
run(
  process.execPath,
  ["--experimental-sea-config", seaConfigPath],
  "sea config",
);
copyFileSync(process.execPath, outfile);
chmodSync(outfile, 0o755);

const postject = join(repoRoot, "node_modules", ".bin", "postject");
if (!statSync(postject, { throwIfNoEntry: false })) {
  throw new Error(
    `missing ${postject}; add the root devDependency \`postject\` and run pnpm install`,
  );
}
run(
  postject,
  [outfile, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SENTINEL_FUSE],
  "postject",
);
chmodSync(outfile, 0o755);

const size = statSync(outfile).size;
const gzip = gzipSync(readFileSync(outfile), { level: 9 }).length;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `[build-sea] wrote ${outfile} (${mb(size)}, gzip ${mb(gzip)}, ${manifest.length} assets, unstripped)`,
);

function walk(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function run(command, argv, label) {
  const result = spawnSync(command, argv, { cwd: buildDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.status)}`);
  }
}
