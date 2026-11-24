import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

const SIZE = 2 * 1024 * 1024;

interface Snapshot {
  phase: string;
  link?: string;
  guests: Array<{ id: string; status: string; path?: string }>;
  files: Array<{ id: number; name: string }>;
  assignments: Record<string, string[]>;
  transfer?: { sentBytes: number; totalBytes: number };
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

function hashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("AC6: two guests are served sequentially with a per-file × per-person matrix", async ({ browser }) => {
  const bytes = randomBytes(SIZE);
  const expected = hashOf(bytes);

  const hostPage = await browser.newContext();
  const guest1Context = await browser.newContext();
  const guest2Context = await browser.newContext();
  const host = await hostPage.newPage();
  const guest1 = await guest1Context.newPage();
  const guest2 = await guest2Context.newPage();
  const pageErrors: string[] = [];
  for (const [name, page] of [
    ["host", host],
    ["g1", guest1],
    ["g2", guest2],
  ] as const) {
    page.on("pageerror", (error) => pageErrors.push(`${name}: ${String(error)}`));
  }

  await host.goto("/");
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 30_000 }).toBe("waiting");
  const link = (await snapshot(host)).link!;

  await guest1.goto(link);
  await guest2.goto(link);
  await expect.poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 }).toBe(2);
  for (const target of [1, 2]) {
    // The approve button only exists while a guest is pending, so always click the first one.
    await host.getByTestId("approve").first().click({ timeout: 30_000 });
    await expect
      .poll(async () => (await snapshot(host)).guests.filter((g) => g.status === "joined").length, {
        timeout: 30_000,
      })
      .toBe(target);
  }

  await host.getByTestId("file-input").setInputFiles({
    name: "ac6.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await expect.poll(async () => (await snapshot(guest1)).files.length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await snapshot(guest2)).files.length, { timeout: 30_000 }).toBe(1);

  // Default matrix: every joined guest is selected for the new file.
  const matrix = (await snapshot(host)).assignments["1"] ?? [];
  const guestIds = (await snapshot(host)).guests.map((guest) => guest.id);
  expect(matrix.sort()).toEqual(guestIds.sort());

  await host.getByTestId("start-send").click();

  // Guest 1 accepts and is served first; guest 2 must not start before guest 1 finishes.
  await guest1.getByTestId("accept").click();
  await expect.poll(async () => (await snapshot(guest1)).phase, { timeout: 120_000 }).toBe("done");
  const guest2WhileGuest1Done = await snapshot(guest2);
  expect(guest2WhileGuest1Done.phase).not.toBe("done");

  await guest2.getByTestId("accept").click();
  await expect.poll(async () => (await snapshot(guest2)).phase, { timeout: 120_000 }).toBe("done");
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 120_000 }).toBe("done");

  const hash1 = await guest1.evaluate(
    () => (window as unknown as { __crossfile?: { sha256?: string } }).__crossfile?.sha256,
  );
  const hash2 = await guest2.evaluate(
    () => (window as unknown as { __crossfile?: { sha256?: string } }).__crossfile?.sha256,
  );
  expect(hash1).toBe(expected);
  expect(hash2).toBe(expected);
  expect(pageErrors).toEqual([]);

  await hostPage.close();
  await guest1Context.close();
  await guest2Context.close();
});
