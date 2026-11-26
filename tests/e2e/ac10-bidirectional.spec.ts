import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  acceptIncoming,
  createRoom,
  expectHashes,
  fixtureFile,
  joinByLink,
  PATH_LABELS,
  pickFiles,
  snapshot,
  startSend,
  waitForSnapshot,
  waitIncoming,
  waitOthersJoined,
  waitPending,
  waitPhase,
} from "./support.js";

/**
 * AC10 (ADR 0010, phase 1): the admin and the member each send one file in their
 * own direction. Both digests must verify and both sides must report an ICE path.
 */
const SIZE_MB = Number(process.env.E2E_FILE_MB ?? 10);
const SIZE = SIZE_MB * 1024 * 1024;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("AC10: admin→member and member→admin each transfer with matching SHA-256", async ({
  browser,
}) => {
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
  await joinByLink(member, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);

  // --- admin -> member -------------------------------------------------------
  const adminBytes = randomBytes(SIZE);
  const adminExpected = sha256(adminBytes);
  await pickFiles(
    admin,
    fixtureFile(adminBytes, `ac10-admin-${SIZE_MB}mb.bin`),
  );
  await startSend(admin);
  const incomingAtMember = await waitIncoming(member);
  expect(incomingAtMember.totalBytes).toBe(SIZE);
  await acceptIncoming(member);
  await expectHashes([admin, member], adminExpected);

  // Path labels resolve shortly after the pair opens; both directions use the same pair.
  await waitForSnapshot(
    admin,
    (view) => Boolean(view.guests[0]?.path),
    30_000,
    "path label (admin)",
  );
  await waitForSnapshot(
    member,
    (view) => Boolean(view.transfer?.path),
    30_000,
    "path label (member)",
  );
  expect(PATH_LABELS).toContain((await snapshot(admin)).guests[0]?.path);
  expect(PATH_LABELS).toContain((await snapshot(member)).transfer?.path);

  // --- member -> admin -------------------------------------------------------
  const memberBytes = randomBytes(SIZE);
  const memberExpected = sha256(memberBytes);
  await pickFiles(
    member,
    fixtureFile(memberBytes, `ac10-member-${SIZE_MB}mb.bin`),
  );
  await startSend(member);
  const incomingAtAdmin = await waitIncoming(admin);
  expect(incomingAtAdmin.totalBytes).toBe(SIZE);
  await acceptIncoming(admin);
  await waitPhase(member, "transferring", 60_000);
  await expectHashes([admin, member], memberExpected);

  if (pageErrors.length > 0)
    console.log("PAGE ERRORS:", JSON.stringify(pageErrors, null, 2));
  expect(pageErrors).toEqual([]);

  await adminContext.close();
  await memberContext.close();
});
