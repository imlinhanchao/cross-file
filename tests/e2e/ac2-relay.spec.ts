import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AC2: force ICE onto TURN (relay-only) and prove the transfer still verifies.
 *
 * Requires a running coturn and a signaling server configured with TURN_URIS/TURN_SECRET:
 *   docker compose -f infra/docker-compose.yml up -d coturn
 *   TURN_SECRET=... TURN_URIS='turn:127.0.0.1:3478?transport=udp' E2E_RELAY=1 pnpm e2e
 * Without E2E_RELAY=1 this file is skipped so the default suite stays hermetic.
 */
test.skip(process.env.E2E_RELAY !== "1", "set E2E_RELAY=1 with coturn running to run the AC2 relay case");

const SIZE_MB = Number(process.env.E2E_RELAY_MB ?? 20);
const SIZE = SIZE_MB * 1024 * 1024;

interface Snapshot {
  phase: string;
  link?: string;
  guests: Array<{ id: string; status: string; path?: string }>;
  files: Array<{ name: string; size: number }>;
  transfer?: { sentBytes: number; totalBytes: number; path?: string };
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

test("AC2: relay-only (TURN) transfer of a file verifies end to end", async ({ browser }) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const dir = resolve(".cache/fixtures");
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `relay-${SIZE_MB}mb.bin`);
  writeFileSync(filePath, bytes);

  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto("/?relay=1");
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 30_000 }).toBe("waiting");
  const link = (await snapshot(host)).link!;
  await guest.goto(link.replace("#", "?relay=1#"));
  await expect.poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 }).toBe(1);
  await host.getByTestId("approve").click();
  await expect.poll(async () => (await snapshot(host)).guests[0]?.status, { timeout: 30_000 }).toBe("joined");

  await host.getByTestId("file-input").setInputFiles(filePath);
  await expect.poll(async () => (await snapshot(guest)).files.length, { timeout: 30_000 }).toBe(1);
  await guest.getByTestId("accept").click();

  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 180_000 }).toBe("done");
  await expect.poll(async () => (await snapshot(guest)).phase, { timeout: 180_000 }).toBe("done");

  // Every path report must say relay: ICE was restricted to relay candidates.
  // The path label resolves from getStats shortly after the channels open, so poll it.
  await expect
    .poll(async () => (await snapshot(host)).guests[0]?.path, { timeout: 30_000 })
    .toBe("relay");
  await expect.poll(async () => (await snapshot(guest)).transfer?.path, { timeout: 30_000 }).toBe("relay");

  const guestHash = await guest.evaluate(
    () => (window as unknown as { __crossfile?: { sha256?: string } }).__crossfile?.sha256,
  );
  expect(guestHash).toBe(expected);
  expect((await snapshot(host)).result?.sha256).toBe(expected);

  await hostContext.close();
  await guestContext.close();
});
