import { expect, test } from "@playwright/test";

test("6-digit code entry: unknown code is rejected with a clear message", async ({
  page,
}) => {
  await page.goto("/code");
  await page.getByTestId("code-input").fill("000000");
  await page.getByTestId("code-submit").click();

  // The room page joins with the code; the server answers ROOM_NOT_FOUND.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __crossfile?: { snapshot?: () => { phase: string } };
              }
            ).__crossfile?.snapshot?.().phase ?? "loading",
        ),
      { timeout: 30_000 },
    )
    .toBe("error");
  const error = await page.evaluate(
    () =>
      (
        window as unknown as {
          __crossfile?: { snapshot?: () => { error?: string } };
        }
      ).__crossfile?.snapshot?.().error ?? "",
  );
  expect(error).toMatch(/ROOM_NOT_FOUND|房间/);
  await expect(page.getByRole("link", { name: "返回首页" })).toBeVisible();
});

test("6-digit code entry: input is normalised to digits only", async ({
  page,
}) => {
  await page.goto("/code");
  await page.getByTestId("code-input").fill("48a2-91x3");
  await expect(page.getByTestId("code-input")).toHaveValue("482913");
});
