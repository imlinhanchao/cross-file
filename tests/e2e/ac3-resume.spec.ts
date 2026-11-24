import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SIZE_MB = Number(process.env.E2E_RESUME_MB ?? 20);
const SIZE = SIZE_MB * 1024 * 1024;

interface Snapshot {
  phase: string;
  link?: string;
  guests: Array<{ id: string; status: string }>;
  files: Array<{ name: string; size: number }>;
  transfer?: { sentBytes: number; totalBytes: number; path?: string };
  result?: { ok: boolean; sha256?: string };
  notice?: string;
  error?: string;
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __crossfile?: { snapshot?: () => Snapshot } }).__crossfile;
    if (!hook?.snapshot) throw new Error("__crossfile hook missing");
    return hook.snapshot();
  });
}

test("AC3: forced channel drop resumes from the bitmap and the final hash matches", async ({ browser }) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const dir = resolve(".cache/fixtures");
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `resume-${SIZE_MB}mb.bin`);
  writeFileSync(filePath, bytes); // random bytes differ per run: always rewrite

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
  }

  await host.goto("/");
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 30_000 }).toBe("waiting");
  const link = (await snapshot(host)).link;
  await guest.goto(link!);
  await expect.poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 }).toBe(1);
  await host.getByTestId("approve").click();
  await expect.poll(async () => (await snapshot(host)).guests[0]?.status, { timeout: 30_000 }).toBe("joined");

  await host.getByTestId("file-input").setInputFiles(filePath);
  await expect.poll(async () => (await snapshot(guest)).files.length, { timeout: 30_000 }).toBe(1);
  await guest.getByTestId("accept").click();

  // Wait until some chunks are on the wire, then kill the data path (AC3: "50%").
  await expect
    .poll(async () => (await snapshot(host)).transfer?.sentBytes ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(SIZE * 0.2);

  await host.evaluate(() => {
    const hook = (window as unknown as { __cfHost?: { forceDrop: () => void } }).__cfHost;
    if (!hook) throw new Error("__cfHost hook missing");
    hook.forceDrop();
  });

  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 30_000 }).toBe("paused");
  await expect.poll(async () => (await snapshot(guest)).phase, { timeout: 30_000 }).toBe("paused");

  // Host re-offers; the guest replies with a bitmap; only missing chunks travel.
  // (The resume path may go paused -> done without an intermediate "transferring".)
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 180_000 }).toBe("done");
  await expect.poll(async () => (await snapshot(guest)).phase, { timeout: 180_000 }).toBe("done");

  const guestHash = await guest.evaluate(
    () => (window as unknown as { __crossfile?: { sha256?: string } }).__crossfile?.sha256,
  );
  expect(guestHash).toBe(expected);
  expect((await snapshot(host)).result?.sha256).toBe(expected);
  if (pageErrors.length > 0) console.log("PAGE ERRORS:", JSON.stringify(pageErrors, null, 2));
  expect(pageErrors).toEqual([]);

  await hostContext.close();
  await guestContext.close();
});
