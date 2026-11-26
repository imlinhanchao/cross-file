import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  acceptIncoming,
  createRoom,
  expectHashes,
  fixtureFile,
  joinByLink,
  pickFiles,
  startSend,
  waitForSnapshot,
  waitIncoming,
  waitOthersJoined,
  waitPending,
  waitPhase,
} from "./support.js";

const SIZE_MB = Number(process.env.E2E_RESUME_MB ?? 20);
const SIZE = SIZE_MB * 1024 * 1024;

test("AC3: forced channel drop resumes from the bitmap and the final hash matches", async ({
  browser,
}) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const file = fixtureFile(bytes, `resume-${SIZE_MB}mb.bin`);

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

  await pickFiles(admin, file);
  await startSend(admin);
  await waitIncoming(member);
  await acceptIncoming(member);

  // Wait until some chunks are on the wire, then kill the data path (AC3: "50%").
  await waitForSnapshot(
    admin,
    (view) => (view.transfer?.sentBytes ?? 0) > SIZE * 0.2,
    60_000,
    "20% of the file is on the wire",
  );
  await admin.evaluate(() => {
    const hook = (window as unknown as { __cfRoom?: { forceDrop: () => void } })
      .__cfRoom;
    if (!hook) throw new Error("__cfRoom hook missing");
    hook.forceDrop();
  });

  // Both sides notice the lost pair before the admin re-offers (~600 ms rebuild).
  await waitPhase(admin, "paused", 30_000);
  await waitPhase(member, "paused", 30_000);

  // The rebuilt pair resumes from the receiver's bitmap and both hashes verify.
  await expectHashes([admin, member], expected, 240_000);

  if (pageErrors.length > 0)
    console.log("PAGE ERRORS:", JSON.stringify(pageErrors, null, 2));
  expect(pageErrors).toEqual([]);

  await adminContext.close();
  await memberContext.close();
});
