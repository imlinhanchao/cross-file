import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  acceptIncoming,
  createRoom,
  expectHashes,
  joinByLink,
  pickFiles,
  snapshot,
  startSend,
  waitForSnapshot,
  waitIncoming,
  waitOthersJoined,
  waitPending,
  withQuery,
} from "./support.js";

/**
 * Auto-accept (docs/02 §11.3): a real local preference (default off) that skips
 * the consent dialog while keeping the visible state, plus the DEV-ONLY
 * `?autoaccept=1` override the e2e suite and shells rely on.
 */
const SIZE = 2 * 1024 * 1024;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("auto-accept: the room setting accepts without the consent dialog", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  const created = await createRoom(admin);
  await joinByLink(member, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);

  // Default off, and the switch is labelled + associated with the risk hint.
  const toggle = member.getByTestId("auto-accept-toggle");
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toHaveAttribute("aria-describedby", "auto-accept-hint");
  await expect(member.locator("#auto-accept-hint")).toBeVisible();

  await toggle.check();
  await expect(toggle).toBeChecked();
  expect(
    await member.evaluate(() => localStorage.getItem("crossfile.autoAccept")),
  ).toBe("1");

  const bytes = randomBytes(SIZE);
  const expected = sha256(bytes);
  await pickFiles(admin, {
    name: "auto-accept.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await startSend(admin);

  // Accepted automatically: it is transferable without the consent card, and the
  // toast/transfer state is still visible.
  await waitForSnapshot(
    member,
    (view) => Boolean(view.transfers[Object.keys(view.transfers)[0] ?? ""]),
    60_000,
    "auto-accepted transfer started",
  );
  await expect(member.getByTestId("incoming-card")).toHaveCount(0);
  await expect(member.getByTestId("auto-accept-toast")).toBeVisible();

  await expectHashes([admin, member], expected);

  await adminContext.close();
  await memberContext.close();
});

test("auto-accept: the dev ?autoaccept=1 override still accepts without a tap", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  const created = await createRoom(admin);
  // The dev override rides along on the invite link; the local setting stays off.
  await joinByLink(member, created.link, "autoaccept=1");
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);
  expect(
    await member.evaluate(() => localStorage.getItem("crossfile.autoAccept")),
  ).toBeNull();
  // The dev override is active for this page (never persisted): the switch shows
  // the effective state even though the local preference itself stays unset.
  await expect(member.getByTestId("auto-accept-toggle")).toBeChecked();

  const bytes = randomBytes(SIZE);
  const expected = sha256(bytes);
  await pickFiles(admin, {
    name: "auto-accept-dev.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await startSend(admin);
  await waitForSnapshot(
    member,
    (view) => Object.keys(view.transfers).length > 0,
    60_000,
    "dev auto-accept transfer started",
  );
  await expect(member.getByTestId("incoming-card")).toHaveCount(0);
  await expectHashes([admin, member], expected);

  await adminContext.close();
  await memberContext.close();
});

/** Guard: a page without the override or the setting still asks for consent. */
test("auto-accept: default remains off, so the consent dialog still appears", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  const created = await createRoom(admin);
  await joinByLink(member, withQuery(created.link));
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);

  const bytes = randomBytes(1024);
  const expected = sha256(bytes);
  await pickFiles(admin, {
    name: "consent-required.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await startSend(admin);
  const incoming = await waitIncoming(member);
  expect(incoming.totalBytes).toBe(1024);
  await expect(member.getByTestId("incoming-card")).toBeVisible();
  await acceptIncoming(member);
  await expectHashes([admin, member], expected);

  await adminContext.close();
  await memberContext.close();
});
