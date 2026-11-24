/**
 * AC4 cross-machine host loop: keeps a room alive and publishes the join link on
 * the LAN so a remote guest can fetch it at any time.
 *
 * - writes .cache/ac4-link.txt and .cache/share/link.txt (served on :8099)
 * - waits for exactly one guest, approves, sends the file, prints the result
 * - if no guest arrives within the window, closes the room and opens a new one
 *
 * Run: node scripts/ac4-host-loop.mjs [sizeMB]
 */
import { chromium } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SIZE_MB = Number(process.argv[2] ?? 100);
const BASE = process.env.AC4_BASE_URL ?? "https://room.net.time-pack.com";
const GUEST_WAIT_MS = Number(process.env.AC4_GUEST_WAIT_MS ?? 240_000);
const QUERY = process.env.AC4_QUERY ?? "debug=1";
const SIZE = SIZE_MB * 1024 * 1024;
const bytes = randomBytes(SIZE);
const expected = createHash("sha256").update(bytes).digest("hex");

const cache = resolve(".cache");
const share = resolve(cache, "share");
mkdirSync(share, { recursive: true });
const fixture = resolve(cache, `ac4-${SIZE_MB}mb.bin`);
writeFileSync(fixture, bytes);

function publish(link) {
  for (const file of [resolve(cache, "ac4-link.txt"), resolve(share, "link.txt")]) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, link);
    renameSync(tmp, file);
  }
}

function clearPublished() {
  for (const file of [resolve(cache, "ac4-link.txt"), resolve(share, "link.txt")]) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, "");
    renameSync(tmp, file);
  }
}

console.log(`expected sha256: ${expected} (${SIZE} bytes)`);
const browser = await chromium.launch({ channel: "chrome" });

for (let round = 1; round <= 20; round++) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const host = await context.newPage();
  host.on("pageerror", (error) => console.log("[host] PAGEERROR", String(error).slice(0, 200)));
  try {
    await host.goto(`${BASE}/?${QUERY}`);
    await host.waitForFunction(() => window.__crossfile?.snapshot?.().phase === "waiting", null, {
      timeout: 60_000,
    });
    const link = await host.evaluate(() => window.__crossfile.snapshot().link);
    // ?debug=1 before the fragment exposes window.__crossfileRtc on both ends.
    publish(link.replace("#", `?${QUERY}#`));
    console.log(`round ${round}: ROOM LINK ${link}`);

    await host.waitForFunction(() => (window.__crossfile?.snapshot?.().guests ?? []).length >= 1, null, {
      timeout: GUEST_WAIT_MS,
    });
    console.log(`round ${round}: guest joined, approving`);
    await host.getByTestId("approve").first().click();
    await host.waitForFunction(
      () => window.__crossfile?.snapshot?.().guests?.some((guest) => guest.status === "joined"),
      null,
      { timeout: 60_000 },
    );

    await host.getByTestId("file-input").setInputFiles(fixture);
    console.log(`round ${round}: file offered, waiting for transfer`);
    const diag = setInterval(() => {
      void host
        .evaluate(async () => {
          const rtc = window.__crossfileRtc?.host;
          const snap = window.__crossfile?.snapshot?.();
          return {
            phase: snap?.phase,
            transfer: snap?.transfer,
            guests: snap?.guests,
            rtc: rtc ? rtc.state() : null,
            stats: rtc ? await rtc.stats() : null,
          };
        })
        .then((info) => console.log("HOST DIAG", JSON.stringify(info)))
        .catch(() => undefined);
    }, 15_000);
    try {
      await host.waitForFunction(() => window.__crossfile?.snapshot?.().phase === "done", null, {
        timeout: 900_000,
      });
    } finally {
      clearInterval(diag);
    }
    const result = await host.evaluate(() => window.__crossfile.snapshot().result);
    const guests = await host.evaluate(() => window.__crossfile.snapshot().guests);
    console.log(`HOST DONE sha256=${result?.sha256} bytes=${result?.bytes} path=${guests?.[0]?.path}`);
    console.log(`HOST HASH MATCHES EXPECTED: ${result?.sha256 === expected}`);
    await context.close();
    break;
  } catch (error) {
    console.log(`round ${round}: no guest / failed (${String(error).slice(0, 120)}) — opening a new room`);
    await context.close().catch(() => undefined);
    clearPublished();
  }
}

await browser.close();
