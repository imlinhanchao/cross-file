import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import {
  createRoom,
  joinByLink,
  pickFiles,
  snapshot,
  waitForSnapshot,
  waitOthersJoined,
  waitPending,
} from "./support.js";

/**
 * D16 storage-quota guard: a receiver whose origin quota is smaller than the file
 * must refuse it, and the sender must surface the reason.
 *
 * The sender pre-checks the member's advertised capabilities and would not enable
 * its own send button (that gate is covered by the UI), so this spec calls
 * `sendNow()` through the debug hook to exercise the receiver-side refusal: the
 * member still rejects the manifest with TOO_LARGE and both sides end in `error`.
 */
const SIZE_MB = 20;
const SIZE = SIZE_MB * 1024 * 1024;

test("quota guard: a receiver with a 5 MB origin quota refuses a 20 MB file", async ({
  browser,
}) => {
  const bytes = randomBytes(SIZE);
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  await member.addInitScript(() => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: async () => ({ quota: 5 * 1024 * 1024, usage: 0 }) },
    });
  });

  const created = await createRoom(admin);
  await joinByLink(member, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);

  const advertised = (await snapshot(admin)).members.find(
    (entry) => !entry.isAdmin,
  );
  expect(advertised?.caps.storageQuotaMB).toBe(5);

  await pickFiles(admin, {
    name: "quota.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });

  // Bypass the sender-side pre-check: the receiver must refuse on its own.
  await admin.evaluate(() => {
    const hook = (window as unknown as { __cfRoom?: { sendNow: () => void } })
      .__cfRoom;
    if (!hook) throw new Error("__cfRoom hook missing");
    hook.sendNow();
  });

  await waitForSnapshot(
    member,
    (view) => view.phase === "error",
    60_000,
    "member refuses the file",
  );
  expect((await snapshot(member)).error ?? "").toContain("上限");
  await waitForSnapshot(
    admin,
    (view) => view.phase === "error",
    60_000,
    "sender surfaces the refusal",
  );
  expect((await snapshot(admin)).error ?? "").toMatch(/上限|对方设备/);

  await adminContext.close();
  await memberContext.close();
});
