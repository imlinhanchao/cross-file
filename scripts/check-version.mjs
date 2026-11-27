#!/usr/bin/env node
/**
 * Release version gate (docs/release.md).
 *
 * The git tag is the single source of truth for a release: `v0.1.0` means version `0.1.0`.
 * Every manifest that ends up inside a shipped artifact must agree with it, otherwise a
 * release could contain a binary whose reported version differs from its tag.
 *
 * Usage: node scripts/check-version.mjs <version|vX.Y.Z>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const raw = process.argv[2];
const version = raw?.replace(/^v/, "");
if (!version) {
  console.error("usage: node scripts/check-version.mjs <version>");
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a semver version: ${version}`);
  process.exit(2);
}

const root = process.cwd();
const manifests = [
  ["package.json", (json) => json.version],
  ["apps/desktop/package.json", (json) => json.version],
  ["apps/desktop-electron/package.json", (json) => json.version],
  ["apps/mobile/package.json", (json) => json.version],
  ["apps/desktop/src-tauri/tauri.conf.json", (json) => json.version],
  ["apps/mobile/src-tauri/tauri.conf.json", (json) => json.version],
];

const mismatches = [];
for (const [file, pick] of manifests) {
  try {
    const json = JSON.parse(readFileSync(join(root, file), "utf8"));
    const found = pick(json);
    if (found !== version) mismatches.push(`${file}: ${String(found)}`);
  } catch (error) {
    mismatches.push(
      `${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (mismatches.length > 0) {
  console.error(`version ${version} does not match these manifests:`);
  for (const line of mismatches) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`version ${version} matches all ${manifests.length} manifests`);
