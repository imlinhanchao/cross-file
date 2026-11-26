/**
 * Instrumented AC3 debug run (v2): drop the data path mid-transfer and log both sides.
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
const admin = await (await browser.newContext()).newPage();
const member = await (await browser.newContext()).newPage();

const snap = (page) =>
  page.evaluate(() => {
    const state = window.__crossfile?.snapshot?.();
    return {
      phase: state?.phase,
      sent: state?.transfer?.sentBytes,
      total: state?.transfer?.totalBytes,
      err: state?.error,
      notice: state?.notice,
      sas: state?.sasPending,
      members: (state?.members ?? []).map(
        (m) => `${m.isAdmin ? "admin:" : ""}${m.state}`,
      ),
      sha: state?.result?.sha256,
    };
  });

for (const [name, page] of [
  ["admin", admin],
  ["member", member],
]) {
  page.on("pageerror", (e) =>
    console.log(`[${name}] PAGEERROR`, String(e).slice(0, 300)),
  );
  page.on("console", (m) => {
    if (m.text().includes("[cf-"))
      console.log(`[${name}]`, m.text().slice(0, 200));
  });
}

const dump = async (label) =>
  console.log(
    label,
    "admin=",
    JSON.stringify(await snap(admin)),
    "member=",
    JSON.stringify(await snap(member)),
  );

// v2: `/room` creates the room.
await admin.goto(BASE + "/room");
await admin.waitForFunction(
  () => window.__crossfile?.snapshot?.().phase === "waiting",
  null,
  { timeout: 30000 },
);
const link = await admin.evaluate(() => window.__crossfile.snapshot().link);
await member.goto(link);
await admin.waitForFunction(
  () => (window.__crossfile?.snapshot?.().members ?? []).length === 2,
  null,
  { timeout: 30000 },
);
await admin.getByTestId("approve").click();
await admin.waitForFunction(
  () =>
    (window.__crossfile?.snapshot?.().members ?? []).some(
      (m) => !m.isAdmin && m.state === "joined",
    ),
  null,
  { timeout: 30000 },
);
await admin.getByTestId("file-input").setInputFiles(filePath);
await member.waitForFunction(
  () => Boolean(window.__crossfile?.snapshot?.().incoming),
  null,
  { timeout: 30000 },
);
await member.getByTestId("accept").click();
await dump("accepted");

await admin.waitForFunction(
  (size) =>
    (window.__crossfile?.snapshot?.().transfer?.sentBytes ?? 0) > 0.2 * size,
  SIZE,
  { timeout: 60000 },
);
await dump("before drop");
console.log("--- forcing drop");
await admin.evaluate(() => {
  const hook = window.__cfRoom ?? window.__cfHost;
  hook?.forceDrop();
});
await dump("after drop");
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  const a = await snap(admin);
  const g = await snap(member);
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(1)}s] admin=${a.phase} sent=${a.sent} | member=${g.phase} sha=${g.sha?.slice(0, 10) ?? ""} err=${g.err ?? a.err ?? ""}`,
  );
  if (a.phase === "done" && g.phase === "done") break;
  if (a.phase === "error" || g.phase === "error") break;
  if (Date.now() - t0 > 60000) break;
}
await dump("final");
const memberHash = await member.evaluate(
  () => window.__crossfile?.snapshot?.().result?.sha256,
);
console.log("RESULT:", memberHash === expected ? "PASS" : "FAIL");
await browser.close();
process.exit(memberHash === expected ? 0 : 1);
