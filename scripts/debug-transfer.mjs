/**
 * Instrumented M0 debug run (v2, not part of CI): streams both pages' state while a
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
const adminContext = await browser.newContext({
  ignoreHTTPSErrors: process.env.DEBUG_IGNORE_TLS === "1",
});
const memberContext = await browser.newContext({
  ignoreHTTPSErrors: process.env.DEBUG_IGNORE_TLS === "1",
});
const admin = await adminContext.newPage();
const member = await memberContext.newPage();

const snap = (page) =>
  page.evaluate(() => {
    const state = window.__crossfile?.snapshot?.();
    return {
      phase: state?.phase,
      members: (state?.members ?? []).map((m) => ({
        id: m.id,
        admin: m.isAdmin,
        state: m.state,
        path: m.path,
      })),
      files: state?.files?.length,
      incoming: state?.incoming?.files?.length,
      transfer: state?.transfer
        ? {
            direction: state.transfer.direction,
            sent: state.transfer.sentBytes,
            total: state.transfer.totalBytes,
            path: state.transfer.path,
          }
        : undefined,
      result: state?.result,
      error: state?.error,
    };
  });

for (const [name, page] of [
  ["admin", admin],
  ["member", member],
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
  console.log("admin ", JSON.stringify(await snap(admin)));
  console.log("member", JSON.stringify(await snap(member)));
};

// v2: `/room` creates the room.
await admin.goto(BASE + "/room" + (RELAY ? "?relay=1" : ""));
await admin.waitForFunction(
  () => window.__crossfile?.snapshot?.().phase === "waiting",
  null,
  { timeout: 30_000 },
);
const link = await admin.evaluate(() => window.__crossfile.snapshot().link);
const code = await admin.evaluate(() => window.__crossfile.snapshot().code);
console.log("room link:", link, "code:", code);
await dump("admin created");

await member.goto(RELAY ? link.replace("#", "?relay=1#") : link);
await admin.waitForFunction(
  () => (window.__crossfile?.snapshot?.().members ?? []).length === 2,
  null,
  { timeout: 30_000 },
);
await dump("member joined (pending)");

await admin.getByTestId("approve").click();
await admin.waitForFunction(
  () =>
    (window.__crossfile?.snapshot?.().members ?? []).some(
      (m) => !m.isAdmin && m.state === "joined",
    ),
  null,
  { timeout: 30_000 },
);
await dump("approved");

if (SIZE_MB > 40) {
  const dir = resolve(".cache/fixtures");
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `debug-${SIZE_MB}mb.bin`);
  writeFileSync(filePath, bytes);
  await admin.getByTestId("file-input").setInputFiles(filePath);
} else {
  await admin.getByTestId("file-input").setInputFiles({
    name: `debug-${SIZE_MB}mb.bin`,
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
}
await member.waitForFunction(
  () => Boolean(window.__crossfile?.snapshot?.().incoming),
  null,
  { timeout: 30_000 },
);
await dump("manifest arrived");

await member.getByTestId("accept").click();
console.log("member accepted");

const started = Date.now();
let last = "";
for (;;) {
  await new Promise((r) => setTimeout(r, 500));
  const state = await snap(member);
  const line = `[${((Date.now() - started) / 1000).toFixed(1)}s] member phase=${state.phase} recv=${state.transfer?.sent ?? 0}/${state.transfer?.total ?? 0} err=${state.error ?? ""} hash=${state.result?.sha256?.slice(0, 12) ?? ""}`;
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
const memberHash = await member.evaluate(
  () => window.__crossfile?.snapshot?.().result?.sha256,
);
console.log(
  "RESULT:",
  memberHash === expected ? "PASS" : `FAIL (member ${memberHash})`,
);

await browser.close();
process.exit(memberHash === expected ? 0 : 1);
