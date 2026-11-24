import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Accessibility floor for the two main screens (docs/04 §13, WCAG 2.2 AA).
 * We fail on serious/critical violations only: cosmetic "best practice" rules are
 * reported in the HTML artifact instead of blocking.
 */
async function expectNoSeriousViolations(page: import("@playwright/test").Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  if (blocking.length > 0) {
    console.log(
      `[axe:${label}]`,
      JSON.stringify(
        blocking.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.map((node) => node.target).slice(0, 3),
        })),
        null,
        2,
      ),
    );
  }
  expect(blocking, `axe serious/critical violations on ${label}`).toEqual([]);
}

test("a11y: host room and guest confirmation have no serious axe violations", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto("/");
  await expect
    .poll(() => host.evaluate(() => window.__crossfile?.snapshot?.().phase), { timeout: 30_000 })
    .toBe("waiting");
  await expectNoSeriousViolations(host, "host-room");

  const link = await host.evaluate(() => window.__crossfile.snapshot().link);
  await guest.goto(link);
  await expect.poll(() => host.evaluate(() => window.__crossfile?.snapshot?.().guests?.length ?? 0)).toBe(1);
  await host.getByTestId("approve").first().click();
  await host.getByTestId("file-input").setInputFiles({
    name: "a11y.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello crossfile"),
  });
  await expect
    .poll(() => guest.evaluate(() => window.__crossfile?.snapshot?.().files?.length ?? 0), { timeout: 30_000 })
    .toBe(1);
  await expectNoSeriousViolations(guest, "guest-confirm");

  // The end-room dialog must also be accessible (focus moves into the dialog).
  await host.getByRole("button", { name: "结束房间" }).click();
  await expect(host.getByRole("dialog")).toBeVisible();
  const focusedInDialog = await host.evaluate(() =>
    Boolean(document.activeElement?.closest('[role="dialog"]')),
  );
  expect(focusedInDialog).toBe(true);
  await expectNoSeriousViolations(host, "end-room-dialog");
  await host.keyboard.press("Escape");
  await expect(host.getByRole("dialog")).toHaveCount(0);

  await hostContext.close();
  await guestContext.close();
});
