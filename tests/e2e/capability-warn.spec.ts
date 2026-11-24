import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Receiver-side capability gate (docs/01 §6, D16): an iPhone-class receiver with a
 * 100 MB soft limit must see a warning before accepting a 150 MB file, and the
 * transfer must still verify when the user chooses "仍要接收".
 */
const SIZE_MB = 150;
const SIZE = SIZE_MB * 1024 * 1024;

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";

interface Snapshot {
  phase: string;
  link?: string;
  files: Array<{ name: string; size: number }>;
  risk?: { level: string; message: string; softLimitMB: number };
  result?: { ok: boolean; sha256?: string };
  error?: string;
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __crossfile?: { snapshot?: () => Snapshot } }).__crossfile;
    if (!hook?.snapshot) throw new Error("__crossfile hook missing");
    return hook.snapshot();
  });
}

test("capability gate: iPhone-class receiver warns above its 100 MB soft limit", async ({ browser }) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const dir = resolve(".cache/fixtures");
  mkdirSync(dir, { recursive: true });
  const fixture = resolve(dir, `cap-${SIZE_MB}mb.bin`);
  writeFileSync(fixture, bytes);

  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  // Make the guest look like an iPhone to capability detection (no FSA picker).
  await guest.addInitScript((ua) => {
    Object.defineProperty(navigator, "userAgent", { get: () => ua });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
    Object.defineProperty(window, "showSaveFilePicker", { get: () => undefined });
  }, IPHONE_UA);

  await host.goto("/");
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 30_000 }).toBe("waiting");
  const link = (await snapshot(host)).link!;
  await guest.goto(link);
  await expect.poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 }).toBe(1);
  await host.getByTestId("approve").click();
  await expect.poll(async () => (await snapshot(host)).guests[0]?.status, { timeout: 30_000 }).toBe("joined");

  await host.getByTestId("file-input").setInputFiles(fixture);
  await expect.poll(async () => (await snapshot(guest)).files.length, { timeout: 30_000 }).toBe(1);

  // The guest judges the manifest against its own caps: iOS -> 100 MB soft limit.
  const risk = (await snapshot(guest)).risk;
  expect(risk?.level).toBe("warn");
  expect(risk?.softLimitMB).toBe(100);
  await expect(guest.getByTestId("accept")).toHaveText(/仍要接收/);

  await guest.getByTestId("accept").click();
  await expect.poll(async () => (await snapshot(guest)).phase, { timeout: 240_000 }).toBe("done");
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 240_000 }).toBe("done");

  const guestHash = await guest.evaluate(
    () => (window as unknown as { __crossfile?: { sha256?: string } }).__crossfile?.sha256,
  );
  expect(guestHash).toBe(expected);
  expect((await snapshot(host)).result?.sha256).toBe(expected);

  await hostContext.close();
  await guestContext.close();
});
