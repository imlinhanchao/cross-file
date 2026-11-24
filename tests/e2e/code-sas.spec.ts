import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

interface Snapshot {
  phase: string;
  code?: string;
  guests: Array<{ id: string; status: string }>;
  files: Array<{ name: string; size: number }>;
  sas?: string[];
  sasPending?: boolean;
  sasConfirmedByMe?: boolean;
  hasKey?: boolean;
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

const SIZE = 2 * 1024 * 1024;

test("6-digit code join: SAS hand-over, then an encrypted transfer", async ({ browser }) => {
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
  }

  await host.goto("/");
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 30_000 }).toBe("waiting");
  const code = (await snapshot(host)).code;
  expect(code).toMatch(/^[0-9]{6}$/);

  // Guest joins with the 6 digit code: no roomKey in a fragment this time.
  await guest.goto("/code");
  await guest.getByTestId("code-input").fill(code!);
  await guest.getByTestId("code-submit").click();
  await expect.poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 }).toBe(1);
  await host.getByTestId("approve").click();

  // Both sides derive the same 4 emoji from the DTLS fingerprints.
  await expect.poll(async () => (await snapshot(host)).sasPending === true, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await snapshot(guest)).sasPending === true, { timeout: 30_000 }).toBe(true);
  const hostSas = (await snapshot(host)).sas;
  const guestSas = (await snapshot(guest)).sas;
  expect(hostSas).toHaveLength(4);
  expect(guestSas).toEqual(hostSas);

  await host.getByTestId("sas-confirm-host").click();
  await guest.getByTestId("sas-confirm").click();

  // The key only travels after both confirmations.
  await expect.poll(async () => (await snapshot(guest)).hasKey === true, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await snapshot(host)).sasPending, { timeout: 30_000 }).toBe(false);

  await host.getByTestId("file-input").setInputFiles({
    name: "code-path.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await expect.poll(async () => (await snapshot(guest)).files.length, { timeout: 30_000 }).toBe(1);
  await guest.getByTestId("accept").click();

  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 120_000 }).toBe("done");
  await expect.poll(async () => (await snapshot(guest)).phase, { timeout: 120_000 }).toBe("done");
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
