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
  trackErrors,
  waitIncoming,
  waitOthersJoined,
  waitPending,
  waitPhase,
  waitForSnapshot,
} from "./support.js";

const SIZE_MB = Number(process.env.E2E_FILE_MB ?? 10);
const SIZE = SIZE_MB * 1024 * 1024;

test("M0: admin and member transfer a file end to end with matching SHA-256", async ({
  browser,
}) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const file = fixtureFile(bytes, `e2e-v2-${SIZE_MB}mb.bin`);

  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();
  const pageErrors = trackErrors([
    ["admin", admin],
    ["member", member],
  ]);

  // 1. Admin creates the room; the join link carries the room key in the fragment.
  const created = await createRoom(admin);

  // 2. Member opens the link and asks to join.
  await joinByLink(member, created.link);
  await waitPending(admin);

  // 3. Admin approves; both peers open the pair channels.
  await admin.getByTestId("approve").click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);

  // 4. Admin picks the file and starts the transfer; the member sees the manifest.
  await pickFiles(admin, file);
  await startSend(admin);
  const incoming = await waitIncoming(member);
  expect(incoming.totalBytes).toBe(SIZE);
  expect(incoming.files).toHaveLength(1);

  // 5. Member accepts; the admin streams encrypted chunks.
  await acceptIncoming(member);
  await waitPhase(admin, "transferring", 60_000);

  // 6. Both sides independently computed the whole-file digest.
  await expectHashes([admin, member], expected);

  // 7. The ICE path label is reported on both sides (lan / direct / relay).
  await waitForSnapshot(
    admin,
    (view) => Boolean(view.guests[0]?.path),
    30_000,
    "admin path label",
  );
  await waitForSnapshot(
    member,
    (view) => Boolean(view.transfer?.path),
    30_000,
    "member path label",
  );
  expect(PATH_LABELS).toContain((await snapshot(admin)).guests[0]?.path);
  expect(PATH_LABELS).toContain((await snapshot(member)).transfer?.path);

  if (pageErrors.length > 0)
    console.log("PAGE ERRORS:", JSON.stringify(pageErrors, null, 2));
  expect(pageErrors).toEqual([]);

  await adminContext.close();
  await memberContext.close();
});
