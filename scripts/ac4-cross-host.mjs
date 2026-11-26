/**
 * AC4 cross-machine admin: create a room on the public dev origin, wait for the
 * remote member, approve it, send a file and print both hashes.
 *
 * Run: node scripts/ac4-cross-host.mjs [sizeMB]
 * The remote member is driven separately (mac-mini, WebKit/Safari) — the join link
 * is written to .cache/ac4-link.txt as soon as the room exists.
 */
import { chromium } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SIZE_MB = Number(process.argv[2] ?? 100);
const BASE = process.env.AC4_BASE_URL ?? "https://room.net.time-pack.com";
const SIZE = SIZE_MB * 1024 * 1024;
const bytes = randomBytes(SIZE);
const expected = createHash("sha256").update(bytes).digest("hex");

const dir = resolve(".cache");
mkdirSync(dir, { recursive: true });
const fixture = resolve(dir, `ac4-${SIZE_MB}mb.bin`);
writeFileSync(fixture, bytes);
const linkFile = resolve(dir, "ac4-link.txt");
writeFileSync(linkFile, "");

console.log(`expected sha256: ${expected}`);
console.log(`file: ${fixture} (${SIZE} bytes)`);

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const admin = await context.newPage();
admin.on("pageerror", (error) =>
  console.log("[admin] PAGEERROR", String(error).slice(0, 300)),
);

// v2: `/room` creates the room (the entry page is `/`).
await admin.goto(`${BASE}/room`);
await admin.waitForFunction(
  () => window.__crossfile?.snapshot?.().phase === "waiting",
  null,
  { timeout: 60_000 },
);
const link = await admin.evaluate(() => window.__crossfile.snapshot().link);
writeFileSync(linkFile, link);
console.log(`ROOM LINK: ${link}`);
console.log("waiting for remote member…");

await admin.waitForFunction(
  () => (window.__crossfile?.snapshot?.().members ?? []).length >= 2,
  null,
  { timeout: 600_000 },
);
console.log("member joined, approving");
await admin.getByTestId("approve").first().click();
await admin.waitForFunction(
  () =>
    (window.__crossfile?.snapshot?.().members ?? []).some(
      (member) => !member.isAdmin && member.state === "joined",
    ),
  null,
  { timeout: 60_000 },
);

console.log("sending file");
await admin.getByTestId("file-input").setInputFiles(fixture);

// The remote member accepts on its side; wait until this admin reports the transfer done.
await admin.waitForFunction(
  () => window.__crossfile?.snapshot?.().phase === "done",
  null,
  { timeout: 900_000 },
);
const result = await admin.evaluate(() => window.__crossfile.snapshot().result);
const members = await admin.evaluate(
  () => window.__crossfile.snapshot().members,
);
const peer = members.find((member) => !member.isAdmin);
console.log(
  `ADMIN DONE sha256=${result?.sha256} bytes=${result?.bytes} path=${peer?.path}`,
);
console.log(`ADMIN HASH MATCHES EXPECTED: ${result?.sha256 === expected}`);

await browser.close();
