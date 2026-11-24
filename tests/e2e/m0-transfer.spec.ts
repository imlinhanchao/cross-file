import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SIZE_MB = Number(process.env.E2E_FILE_MB ?? 10);
const SIZE = SIZE_MB * 1024 * 1024;

/** Playwright caps setInputFiles buffers at 50 MB, so big fixtures go via disk. */
function fixturePath(bytes: Buffer): { path: string; name: string } {
  const dir = resolve(".cache/fixtures");
  mkdirSync(dir, { recursive: true });
  const name = `e2e-${SIZE_MB}mb.bin`;
  const path = resolve(dir, name);
  if (!existsSync(path)) writeFileSync(path, bytes);
  return { path, name };
}

interface Snapshot {
  phase: string;
  link?: string;
  code?: string;
  guests: Array<{ id: string; status: string; path?: string }>;
  files: Array<{ id: number; name: string; size: number }>;
  transfer?: { sentBytes: number; totalBytes: number; path?: string };
  result?: { ok: boolean; sha256?: string; bytes?: number };
  error?: string;
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __crossfile?: { snapshot?: () => Snapshot } }).__crossfile;
    if (!hook?.snapshot) throw new Error("__crossfile hook missing");
    return hook.snapshot();
  });
}

async function waitPhase(page: Page, phase: string, timeout = 120_000): Promise<void> {
  await expect
    .poll(async () => (await snapshot(page)).phase, { timeout })
    .toBe(phase);
}

test("M0: two browsers transfer a file end to end with matching SHA-256", async ({ browser }) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");

  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  const pageErrors: string[] = [];
  for (const [name, page] of [
    ["host", host],
    ["guest", guest],
  ] as const) {
    page.on("pageerror", (error) => pageErrors.push(`${name}: ${String(error)}`));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(`${name} console: ${message.text()}`);
    });
  }

  const t0 = Date.now();
  const mark = (label: string): void => console.log(`[step ${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
  mark("start");
  // 1. Host creates a room and shows the join link (key lives in the fragment).
  await host.goto("/");
  await waitPhase(host, "waiting");
  mark("host room waiting");
  const created = await snapshot(host);
  expect(created.link).toBeTruthy();
  expect(created.code).toMatch(/^[0-9]{6}$/);
  expect(created.link).toContain("#");

  // 2. Guest opens the link -> joins with proof.
  mark("guest goto link");
  await guest.goto(created.link!);
  await expect.poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await snapshot(host)).guests[0]?.status).toBe("pending");

  // 3. Host approves; both peers open data channels.
  mark("approve click");
  await host.getByTestId("approve").click();
  await expect.poll(async () => (await snapshot(host)).guests[0]?.status, { timeout: 30_000 }).toBe("joined");

  // 4. Host picks the file; the manifest goes over the encrypted ctrl channel.
  mark("set files");
  await host.getByTestId("file-input").setInputFiles(fixturePath(bytes).path);
  await expect.poll(async () => (await snapshot(guest)).files.length, { timeout: 30_000 }).toBe(1);
  const manifest = await snapshot(guest);
  expect(manifest.files[0]?.size).toBe(SIZE);

  // 5. Guest accepts; host streams encrypted chunks.
  // 5. Host presses "start sending" (arms the transfer), then the guest accepts.
  mark("start-send click");
  await host.getByTestId("start-send").click({ timeout: 10_000 });
  mark("start-send clicked (waiting for guest accept)");
  await guest.getByTestId("accept").click();
  await expect.poll(async () => (await snapshot(host)).phase).toBe("transferring");
  mark("after accept click");

  await waitPhase(host, "done");
  mark("host done");
  await waitPhase(guest, "done");
  mark("guest done");

  // 6. Both sides independently computed the whole-file digest.
  const guestHash = await guest.evaluate(
    () => (window as unknown as { __crossfile?: { sha256?: string } }).__crossfile?.sha256,
  );
  const hostResult = await snapshot(host);
  expect(hostResult.result?.sha256).toBe(expected);
  expect(guestHash).toBe(expected);
  expect(pageErrors).toEqual([]);

  await hostContext.close();
  await guestContext.close();
});
