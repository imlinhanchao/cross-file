import { expect, test, type Page } from "@playwright/test";

interface Snapshot {
  phase: string;
  error?: string;
}

function snapshot(page: Page): Promise<Snapshot> {
  // During the redirect to /j/<code> the document may still be loading; treat that as unknown.
  return page.evaluate(() => {
    const hook = (window as unknown as { __crossfile?: { snapshot?: () => Snapshot } }).__crossfile;
    if (!hook?.snapshot) return { phase: "loading" };
    return hook.snapshot();
  });
}

test("6-digit code entry: unknown code is rejected with a clear message", async ({ page }) => {
  await page.goto("/code");
  await page.getByTestId("code-input").fill("000000");
  await page.getByTestId("code-submit").click();

  // The room page joins with the code; the server answers ROOM_NOT_FOUND.
  await expect.poll(async () => (await snapshot(page)).phase, { timeout: 30_000 }).toBe("error");
  expect((await snapshot(page)).error ?? "").toMatch(/ROOM_NOT_FOUND|房间/);
  await expect(page.getByRole("link", { name: "返回首页" })).toBeVisible();
});

test("6-digit code entry: input is normalised to digits only", async ({ page }) => {
  await page.goto("/code");
  await page.getByTestId("code-input").fill("48a2-91x3");
  await expect(page.getByTestId("code-input")).toHaveValue("482913");
});
