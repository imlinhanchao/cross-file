import { expect, test, type Page } from "@playwright/test";

interface Snapshot {
  phase: string;
  code?: string;
  guests: Array<{ id: string; status: string }>;
  sas?: string[];
  sasPending?: boolean;
  error?: string;
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const hook = (
      window as unknown as { __crossfile?: { snapshot?: () => Snapshot } }
    ).__crossfile;
    if (!hook?.snapshot) return { phase: "loading", guests: [] };
    return hook.snapshot();
  });
}

/**
 * docs/02 §4.5: the 4-emoji SAS must be confirmed within 60 s. Both sides use a
 * dev-only ?sasTimeoutMs override here so the test finishes in seconds.
 */
test("SAS confirmation timeout aborts the pairing on both sides", async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto("/?sasTimeoutMs=800");
  await expect
    .poll(async () => (await snapshot(host)).phase, { timeout: 30_000 })
    .toBe("waiting");
  const code = (await snapshot(host)).code!;
  expect(code).toMatch(/^[0-9]{6}$/);

  await guest.goto(`/j/${code}?debug=1&sasTimeoutMs=800`);
  await expect
    .poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 })
    .toBe(1);
  await host.getByTestId("approve").first().click();
  await expect
    .poll(async () => (await snapshot(guest)).sasPending, { timeout: 30_000 })
    .toBe(true);
  expect((await snapshot(guest)).sas).toHaveLength(4);

  // Nobody confirms: both sides must give up with an actionable message.
  await expect
    .poll(async () => (await snapshot(guest)).phase, { timeout: 20_000 })
    .toBe("error");
  expect((await snapshot(guest)).error ?? "").toMatch(/超时|安全码/);
  await expect
    .poll(async () => (await snapshot(host)).phase, { timeout: 20_000 })
    .toBe("error");
  expect((await snapshot(host)).error ?? "").toMatch(/超时|安全码/);

  await hostContext.close();
  await guestContext.close();
});
