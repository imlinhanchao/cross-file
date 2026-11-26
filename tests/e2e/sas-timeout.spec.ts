import { expect, test } from "@playwright/test";
import {
  createRoom,
  joinByCode,
  snapshot,
  waitForSnapshot,
  waitPending,
} from "./support.js";

/**
 * docs/02 §4.5: the 4-emoji SAS must be confirmed within 60 s. Both sides use a
 * dev-only ?sasTimeoutMs override here so the test finishes in seconds.
 */
test("SAS confirmation timeout aborts the pairing on both sides", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  const created = await createRoom(admin, "sasTimeoutMs=800");

  await joinByCode(member, created.code, "sasTimeoutMs=800");
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitForSnapshot(
    member,
    (view) => view.sasPending === true,
    30_000,
    "member SAS",
  );
  expect((await snapshot(member)).sas).toHaveLength(4);

  // Nobody confirms: both sides must give up with an actionable message.
  await waitForSnapshot(
    member,
    (view) => view.phase === "error",
    20_000,
    "member SAS timeout",
  );
  // The admin aborts and closes the room, so the member sees either the SAS hint
  // (its own timer) or the room-closed message (the admin's close wins the race).
  expect((await snapshot(member)).error ?? "").toMatch(
    /超时|安全码|房间已结束/,
  );
  await waitForSnapshot(
    admin,
    (view) => view.phase === "error",
    20_000,
    "admin SAS timeout",
  );
  expect((await snapshot(admin)).error ?? "").toMatch(/超时|安全码/);

  await adminContext.close();
  await memberContext.close();
});
