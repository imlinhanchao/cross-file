import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

/**
 * D16 storage-quota guard: a receiver whose origin quota is smaller than the file
 * must refuse it before any byte is written, and the host must surface the reason.
 */
const SIZE_MB = 20;
const SIZE = SIZE_MB * 1024 * 1024;

interface Snapshot {
  phase: string;
  link?: string;
  guests: Array<{
    id: string;
    status: string;
    caps?: { storageQuotaMB?: number };
  }>;
  error?: string;
  files: Array<{ name: string }>;
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const hook = (
      window as unknown as { __crossfile?: { snapshot?: () => Snapshot } }
    ).__crossfile;
    if (!hook?.snapshot) return { phase: "loading", guests: [], files: [] };
    return hook.snapshot();
  });
}

test("quota guard: a receiver with a 5 MB origin quota refuses a 20 MB file", async ({
  browser,
}) => {
  const bytes = randomBytes(SIZE);
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await guest.addInitScript(() => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: async () => ({ quota: 5 * 1024 * 1024, usage: 0 }) },
    });
  });

  await host.goto("/");
  await expect
    .poll(async () => (await snapshot(host)).phase, { timeout: 30_000 })
    .toBe("waiting");
  const link = (await snapshot(host)).link!;
  await guest.goto(link);
  await expect
    .poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 })
    .toBe(1);
  await host.getByTestId("approve").first().click();
  await expect
    .poll(async () => (await snapshot(host)).guests[0]?.status, {
      timeout: 30_000,
    })
    .toBe("joined");
  expect((await snapshot(host)).guests[0]?.caps?.storageQuotaMB).toBe(5);

  await host.getByTestId("file-input").setInputFiles({
    name: "quota.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });

  await expect
    .poll(async () => (await snapshot(guest)).phase, { timeout: 60_000 })
    .toBe("error");
  expect((await snapshot(guest)).error ?? "").toContain("上限");
  await expect
    .poll(async () => (await snapshot(host)).phase, { timeout: 60_000 })
    .toBe("error");
  expect((await snapshot(host)).error ?? "").toMatch(/上限|对方设备/);

  await hostContext.close();
  await guestContext.close();
});
