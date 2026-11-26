import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  joinByLink,
  snapshot,
  waitForSnapshot,
  waitIncoming,
  waitOthersJoined,
  waitPending,
} from "./support.js";

/**
 * Accessibility floor for the main screens (docs/04 §13, WCAG 2.2 AA):
 * entry page, room page (both themes), member confirmation and the end-room dialog.
 * We fail on serious/critical violations only: cosmetic "best practice" rules are
 * reported in the HTML artifact instead of blocking.
 */
async function expectNoSeriousViolations(
  page: import("@playwright/test").Page,
  label: string,
) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
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

test("a11y: entry, room, member confirmation and end-room dialog have no serious axe violations", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  // 1. Entry page: create / join.
  await admin.goto("/");
  await expect(admin.getByTestId("create-room")).toBeVisible();
  await expectNoSeriousViolations(admin, "entry");

  // 2. Room page (admin, waiting for a member) in both themes.
  await admin.goto("/room");
  await waitForSnapshot(admin, (view) => view.phase === "waiting", 30_000);
  await expectNoSeriousViolations(admin, "room-admin");
  await admin.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expectNoSeriousViolations(admin, "room-admin-dark");
  await admin.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });

  // 3. Member confirmation card.
  const link = (await snapshot(admin)).link as string;
  await joinByLink(member, link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 1);

  await admin.getByTestId("file-input").setInputFiles({
    name: "a11y.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello crossfile"),
  });
  await admin.getByTestId("start-send").click();
  await waitIncoming(member);
  await expect(member.getByTestId("incoming-card")).toBeVisible();
  await expectNoSeriousViolations(member, "member-confirm");

  // 4. The end-room dialog must be accessible (focus moves into the dialog).
  await admin.getByRole("button", { name: "结束房间" }).click();
  await expect(admin.getByRole("dialog")).toBeVisible();
  const focusedInDialog = await admin.evaluate(() =>
    Boolean(document.activeElement?.closest('[role="dialog"]')),
  );
  expect(focusedInDialog).toBe(true);
  await expectNoSeriousViolations(admin, "end-room-dialog");
  await admin.keyboard.press("Escape");
  await expect(admin.getByRole("dialog")).toHaveCount(0);

  await adminContext.close();
  await memberContext.close();
});
