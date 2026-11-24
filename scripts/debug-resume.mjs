/**
 * Instrumented AC3 debug run: drop the data path mid-transfer and log both sides.
 * Usage: node scripts/debug-resume.mjs [sizeMB]
 * Expects: signaling on 8791, vite on 5175.
 */
import { chromium } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SIZE_MB = Number(process.argv[2] ?? 20);
const BASE = process.env.DEBUG_BASE_URL ?? "http://127.0.0.1:5175";
const SIZE = SIZE_MB * 1024 * 1024;
const bytes = randomBytes(SIZE);
const expected = createHash("sha256").update(bytes).digest("hex");
const dir = resolve(".cache/fixtures");
mkdirSync(dir, { recursive: true });
const filePath = resolve(dir, `resume-debug-${SIZE_MB}mb.bin`);
writeFileSync(filePath, bytes); // always rewrite: the random bytes differ per run

const browser = await chromium.launch({ channel: "chrome" });
const host = await (await browser.newContext()).newPage();
const guest = await (await browser.newContext()).newPage();

const snap = (page) =>
  page.evaluate(() => {
    const s = window.__crossfile?.snapshot?.();
    return {
      phase: s?.phase,
      sent: s?.transfer?.sentBytes,
      total: s?.transfer?.totalBytes,
      err: s?.error,
      notice: s?.notice,
      sas: s?.sasPending,
      guests: s?.guests?.map((g) => g.status),
      sha: window.__crossfile?.sha256,
    };
  });

for (const [name, page] of [["host", host], ["guest", guest]]) {
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, String(e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.text().includes("[cf-")) console.log(`[${name}]`, m.text().slice(0, 200));
  });
}

const dump = async (label) => console.log(label, "host=", JSON.stringify(await snap(host)), "guest=", JSON.stringify(await snap(guest)));

await host.goto(BASE + "/");
await host.waitForFunction(() => window.__crossfile?.snapshot?.().phase === "waiting", null, { timeout: 30000 });
const link = await host.evaluate(() => window.__crossfile.snapshot().link);
await guest.goto(link);
await host.waitForFunction(() => window.__crossfile?.snapshot?.().guests?.length === 1, null, { timeout: 30000 });
await host.getByTestId("approve").click();
await host.waitForFunction(() => window.__crossfile?.snapshot?.().guests?.[0]?.status === "joined", null, { timeout: 30000 });
await host.getByTestId("file-input").setInputFiles(filePath);
await guest.waitForFunction(() => window.__crossfile?.snapshot?.().files?.length === 1, null, { timeout: 30000 });
await guest.getByTestId("accept").click();
await dump("accepted");

await host.waitForFunction((size) => (window.__crossfile?.snapshot?.().transfer?.sentBytes ?? 0) > 0.2 * size, SIZE, { timeout: 60000 });
await dump("before drop");
console.log("--- forcing drop");
await host.evaluate(() => window.__cfHost?.forceDrop());
await dump("after drop");
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  const h = await snap(host);
  const g = await snap(guest);
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] host=${h.phase} sent=${h.sent} | guest=${g.phase} sha=${g.sha?.slice(0, 10) ?? ""} err=${g.err ?? h.err ?? ""}`);
  if (h.phase === "done" && g.phase === "done") break;
  if (h.phase === "error" || g.phase === "error") break;
  if (Date.now() - t0 > 60000) break;
}
await dump("final");
const guestHash = await guest.evaluate(() => window.__crossfile?.sha256);
console.log("RESULT:", guestHash === expected ? "PASS" : "FAIL");
await browser.close();
process.exit(guestHash === expected ? 0 : 1);
