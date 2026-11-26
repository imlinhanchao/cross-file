import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  acceptIncoming,
  createRoom,
  expectHashes,
  joinByCode,
  pickFiles,
  snapshot,
  startSend,
  waitIncoming,
  waitOthersJoined,
  waitPending,
  waitForSnapshot,
} from "./support.js";

const SIZE = 2 * 1024 * 1024;

test("6-digit code join: SAS hand-over, then an encrypted transfer", async ({
  browser,
}) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");

  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();
  const pageErrors: string[] = [];
  for (const [name, page] of [
    ["admin", admin],
    ["member", member],
  ] as const) {
    page.on("pageerror", (error) =>
      pageErrors.push(`${name}: ${String(error)}`),
    );
  }

  const created = await createRoom(admin);

  // The member joins with the 6-digit code: no roomKey in a fragment this time.
  await joinByCode(member, created.code);
  await waitPending(admin);
  await admin.getByTestId("approve").click();

  // Both sides derive the same 4 emoji from the DTLS fingerprints.
  await waitForSnapshot(
    admin,
    (view) => view.sasPending === true,
    30_000,
    "admin SAS",
  );
  await waitForSnapshot(
    member,
    (view) => view.sasPending === true,
    30_000,
    "member SAS",
  );
  const adminSas = (await snapshot(admin)).sas;
  const memberSas = (await snapshot(member)).sas;
  expect(adminSas).toHaveLength(4);
  expect(memberSas).toEqual(adminSas);

  await admin.getByTestId("sas-confirm-host").click();
  await member.getByTestId("sas-confirm").click();

  // The room key only travels after both confirmations.
  await waitForSnapshot(
    member,
    (view) => view.hasKey === true,
    30_000,
    "member hasKey",
  );
  await waitForSnapshot(
    admin,
    (view) => view.sasPending === false,
    30_000,
    "admin SAS done",
  );
  await waitOthersJoined(member, 1);

  await pickFiles(admin, {
    name: "code-path.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await startSend(admin);
  await waitIncoming(member);
  await acceptIncoming(member);

  await expectHashes([admin, member], expected);
  if (pageErrors.length > 0)
    console.log("PAGE ERRORS:", JSON.stringify(pageErrors, null, 2));
  expect(pageErrors).toEqual([]);

  await adminContext.close();
  await memberContext.close();
});
