import { expect, test } from "@playwright/test";
import {
  createRoom,
  joinByLink,
  memberById,
  snapshot,
  waitForSnapshot,
  waitOthersJoined,
  waitPending,
} from "./support.js";

const NAME_STORAGE_KEY = "crossfile.displayName";
const DEFAULT_NAME = /^.+ · [A-Z2-7]{4}$/u;

/** Read the remembered display name straight from the page's localStorage. */
function storedName(
  page: import("@playwright/test").Page,
): Promise<string | null> {
  return page.evaluate(
    (key) =>
      (
        window as unknown as {
          localStorage: { getItem: (name: string) => string | null };
        }
      ).localStorage.getItem(key),
    NAME_STORAGE_KEY,
  );
}

test("AC13: renaming broadcasts, 'forget' regenerates a default name, and the name persists across reloads", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  const created = await createRoom(admin);
  const adminId = (await snapshot(admin)).selfId as string;
  await joinByLink(member, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").click();
  await waitOthersJoined(admin, 1);

  // 1. Rename the admin; the member sees the new name in the member list.
  await admin.getByTestId("name-edit").click();
  // Regression: the dialog used to re-run its focus effect on every keystroke (inline
  // onCancel), stealing focus back to the confirm button while typing.
  const nameInput = admin.getByTestId("name-input");
  await nameInput.click();
  await nameInput.press("End");
  await admin.keyboard.type("x");
  expect(
    await admin.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    ),
  ).toBe("name-input");
  await nameInput.fill("管理员甲");
  await admin.getByTestId("name-save").click();
  await waitForSnapshot(
    member,
    (view) => memberById(view, adminId)?.name === "管理员甲",
    30_000,
    "member sees the rename",
  );
  expect(await storedName(admin)).toBe("管理员甲");

  // 2. "Forget" clears the local memory and regenerates the platform default.
  await admin.getByTestId("name-edit").click();
  await admin.getByTestId("name-forget").click();
  const regenerated = await admin.getByTestId("name-input").inputValue();
  expect(regenerated).toMatch(DEFAULT_NAME);
  expect(regenerated).not.toBe("管理员甲");
  await admin.getByTestId("name-save").click();
  await waitForSnapshot(
    member,
    (view) => memberById(view, adminId)?.name === regenerated,
    30_000,
    "member sees the regenerated name",
  );
  expect(await storedName(admin)).toBe(regenerated);

  // 3. The remembered name survives a reload (local memory, ADR 0010 §names).
  await admin.reload();
  await admin.waitForFunction(() =>
    Boolean(
      (
        window as unknown as {
          __crossfile?: { snapshot?: () => unknown };
        }
      ).__crossfile?.snapshot,
    ),
  );
  expect(await storedName(admin)).toBe(regenerated);

  await adminContext.close();
  await memberContext.close();
});

test("AC13: duplicate names are de-duplicated with a -2 suffix", async ({
  browser,
}) => {
  // Two devices remember the same display name; the server must keep them apart.
  const adminContext = await browser.newContext();
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  for (const context of [firstContext, secondContext]) {
    await context.addInitScript(
      (key) => localStorage.setItem(key, "同名设备"),
      NAME_STORAGE_KEY,
    );
  }
  const admin = await adminContext.newPage();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  const created = await createRoom(admin);
  await joinByLink(first, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 1);

  await joinByLink(second, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 2);

  await waitForSnapshot(
    admin,
    (view) => {
      const names = view.members
        .filter((member) => !member.isAdmin)
        .map((member) => member.name);
      return names.includes("同名设备") && names.includes("同名设备-2");
    },
    30_000,
    "duplicate names are suffixed",
  );

  // Both member pages also see the de-duplicated room-wide list.
  for (const page of [first, second]) {
    await waitForSnapshot(
      page,
      (view) => {
        const names = view.members.map((member) => member.name);
        return names.includes("同名设备") && names.includes("同名设备-2");
      },
      30_000,
      "member sees de-duplicated names",
    );
  }

  await adminContext.close();
  await firstContext.close();
  await secondContext.close();
});
