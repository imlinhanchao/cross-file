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
  waitIncoming,
  waitOthersJoined,
  waitPending,
} from "./support.js";

const SIZE = 2 * 1024 * 1024;

/**
 * AC6: one admin, two members. The file × member matrix is maintained per sender
 * and every member can be served on its own pair (docs/01 D18/D9: different pairs
 * may run in parallel; the same-pair serial rule is AC11).
 */
test("AC6: two members receive the file with a per-file × per-member matrix", async ({
  browser,
}) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");

  const adminContext = await browser.newContext();
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const pageErrors: string[] = [];
  for (const [name, page] of [
    ["admin", admin],
    ["first", first],
    ["second", second],
  ] as const) {
    page.on("pageerror", (error) =>
      pageErrors.push(`${name}: ${String(error)}`),
    );
  }

  const created = await createRoom(admin);

  // Members join one at a time so their join order (and thus the matrix) is stable.
  await joinByLink(first, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click({ timeout: 30_000 });
  await waitOthersJoined(admin, 1);

  await joinByLink(second, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click({ timeout: 30_000 });
  await waitOthersJoined(admin, 2);
  await waitOthersJoined(first, 2);
  await waitOthersJoined(second, 2);

  await pickFiles(admin, {
    name: "ac6.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await expect
    .poll(async () => (await snapshot(admin)).files.length, { timeout: 30_000 })
    .toBe(1);

  // Default matrix: every joined member is selected for the new file.
  const matrix = (await snapshot(admin)).assignments["1"] ?? [];
  const memberIds = (await snapshot(admin)).members
    .filter((member) => !member.isAdmin)
    .map((member) => member.id);
  expect(matrix.sort()).toEqual(memberIds.sort());

  await startSend(admin);
  const [incomingFirst, incomingSecond] = await Promise.all([
    waitIncoming(first),
    waitIncoming(second),
  ]);
  expect(incomingFirst.totalBytes).toBe(SIZE);
  expect(incomingSecond.totalBytes).toBe(SIZE);

  await acceptIncoming(first);
  await acceptIncoming(second);

  await expectHashes([admin, first, second], expected);
  expect(pageErrors).toEqual([]);

  await adminContext.close();
  await firstContext.close();
  await secondContext.close();
});
