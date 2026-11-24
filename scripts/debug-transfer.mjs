/**
 * Instrumented M0 debug run (not part of CI): streams both pages' state while a
 * file moves end to end, so a hang or hash mismatch can be localised quickly.
 *
 * Usage: node scripts/debug-transfer.mjs [sizeMB]
 * Expects: signaling on 8791, vite on 5175 (see package.json dev scripts).
 */
import { chromium } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SIZE_MB = Number(process.argv[2] ?? 10);
const BASE = process.env.DEBUG_BASE_URL ?? "http://127.0.0.1:5175";
const RELAY = process.env.DEBUG_RELAY === "1";
const MAX_WAIT_MS = Number(process.env.DEBUG_MAX_SECONDS ?? 120) * 1000;
const bytes = randomBytes(SIZE_MB * 1024 * 1024);
const expected = createHash("sha256").update(bytes).digest("hex");
console.log("expected sha256:", expected, "size:", bytes.length);

const browser = await chromium.launch({ channel: "chrome" });
const hostContext = await browser.newContext({
  ignoreHTTPSErrors: process.env.DEBUG_IGNORE_TLS === "1",
});
const guestContext = await browser.newContext({
  ignoreHTTPSErrors: process.env.DEBUG_IGNORE_TLS === "1",
});
const host = await hostContext.newPage();
const guest = await guestContext.newPage();

const snap = (page) =>
  page.evaluate(() => {
    const state = window.__crossfile?.snapshot?.();
    const extra = {
      sha256: window.__crossfile?.sha256,
      expected: window.__crossfile?.expected,
      complete: window.__crossfile?.complete,
    };
    return {
      phase: state?.phase,
      guests: state?.guests?.map((g) => ({
        id: g.id,
        status: g.status,
        path: g.path,
      })),
      files: state?.files?.length,
      transfer: state?.transfer
        ? {
            sent: state.transfer.sentBytes,
            total: state.transfer.totalBytes,
            path: state.transfer.path,
          }
        : undefined,
      result: state?.result,
      error: state?.error,
      extra,
    };
  });

for (const [name, page] of [
  ["host", host],
  ["guest", guest],
]) {
  page.on("pageerror", (error) =>
    console.log(`[${name}] PAGEERROR`, String(error).slice(0, 400)),
  );
  page.on("console", (message) => {
    const text = message.text();
    if (
      text.includes("[cf-") ||
      ["error", "warning"].includes(message.type())
    ) {
      console.log(`[${name}] console.${message.type()}`, text.slice(0, 300));
    }
  });
}

const dump = async (label) => {
  console.log(`--- ${label}`);
  console.log("host ", JSON.stringify(await snap(host)));
  console.log("guest", JSON.stringify(await snap(guest)));
};

await host.goto(BASE + "/" + (RELAY ? "?relay=1" : ""));
await host.waitForFunction(
  () => window.__crossfile?.snapshot?.().phase === "waiting",
  null,
  { timeout: 30_000 },
);
const link = await host.evaluate(() => window.__crossfile.snapshot().link);
const code = await host.evaluate(() => window.__crossfile.snapshot().code);
console.log("room link:", link, "code:", code);
await dump("host created");

await guest.goto(RELAY ? link.replace("#", "?relay=1#") : link);
await host.waitForFunction(
  () => (window.__crossfile?.snapshot?.().guests ?? []).length === 1,
  null,
  { timeout: 30_000 },
);
await dump("guest joined (pending)");

await host.getByTestId("approve").click();
await host.waitForFunction(
  () => window.__crossfile?.snapshot?.().guests?.[0]?.status === "joined",
  null,
  { timeout: 30_000 },
);
await dump("approved");

if (SIZE_MB > 40) {
  const dir = resolve(".cache/fixtures");
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `debug-${SIZE_MB}mb.bin`);
  writeFileSync(filePath, bytes);
  await host.getByTestId("file-input").setInputFiles(filePath);
} else {
  await host.getByTestId("file-input").setInputFiles({
    name: `debug-${SIZE_MB}mb.bin`,
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
}
await guest.waitForFunction(
  () => (window.__crossfile?.snapshot?.().files ?? []).length === 1,
  null,
  { timeout: 30_000 },
);
await dump("manifest arrived");

await guest.getByTestId("accept").click();
console.log("guest accepted");

const started = Date.now();
let last = "";
for (;;) {
  await new Promise((r) => setTimeout(r, 500));
  const state = await snap(guest);
  const line = `[${((Date.now() - started) / 1000).toFixed(1)}s] guest phase=${state.phase} recv=${state.transfer?.sent ?? 0}/${state.transfer?.total ?? 0} err=${state.error ?? ""} hash=${state.extra?.sha256?.slice(0, 12) ?? ""} complete=${state.extra?.complete}`;
  if (line !== last) {
    console.log(line);
    last = line;
  }
  if (state.phase === "done" || state.phase === "error") break;
  if (Date.now() - started > MAX_WAIT_MS) {
    console.log("TIMEOUT");
    break;
  }
}
await dump("final");
const guestHash = await guest.evaluate(() => window.__crossfile?.sha256);
console.log(
  "RESULT:",
  guestHash === expected ? "PASS" : `FAIL (guest ${guestHash})`,
);

await browser.close();
process.exit(guestHash === expected ? 0 : 1);
