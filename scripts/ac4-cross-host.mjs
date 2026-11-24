/**
 * AC4 cross-machine host: create a room on the public dev origin, wait for the
 * remote guest, approve it, send a file and print both hashes.
 *
 * Run: node scripts/ac4-cross-host.mjs [sizeMB]
 * The remote guest is driven separately (mac-mini, WebKit/Safari) — the join link
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
const host = await context.newPage();
host.on("pageerror", (error) => console.log("[host] PAGEERROR", String(error).slice(0, 300)));

await host.goto(`${BASE}/`);
await host.waitForFunction(() => window.__crossfile?.snapshot?.().phase === "waiting", null, { timeout: 60_000 });
const link = await host.evaluate(() => window.__crossfile.snapshot().link);
writeFileSync(linkFile, link);
console.log(`ROOM LINK: ${link}`);
console.log("waiting for remote guest…");

await host.waitForFunction(() => (window.__crossfile?.snapshot?.().guests ?? []).length >= 1, null, {
  timeout: 600_000,
});
console.log("guest joined, approving");
await host.getByTestId("approve").first().click();
await host.waitForFunction(
  () => window.__crossfile?.snapshot?.().guests?.some((guest) => guest.status === "joined"),
  null,
  { timeout: 60_000 },
);

console.log("sending file");
await host.getByTestId("file-input").setInputFiles(fixture);

// The remote guest accepts on its side; wait until this host reports the transfer done.
await host.waitForFunction(() => window.__crossfile?.snapshot?.().phase === "done", null, { timeout: 900_000 });
const result = await host.evaluate(() => window.__crossfile.snapshot().result);
const guestInfo = await host.evaluate(() => window.__crossfile.snapshot().guests);
console.log(`HOST DONE sha256=${result?.sha256} bytes=${result?.bytes} path=${guestInfo?.[0]?.path}`);
console.log(`HOST HASH MATCHES EXPECTED: ${result?.sha256 === expected}`);

await browser.close();
