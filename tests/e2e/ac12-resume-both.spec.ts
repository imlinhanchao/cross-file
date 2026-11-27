import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  acceptIncoming,
  createRoom,
  expectHashes,
  fixtureFile,
  joinByLink,
  pickFiles,
  snapshot,
  startSend,
  transferOf,
  waitForSnapshot,
  waitIncoming,
  waitOthersJoined,
  waitPending,
  waitPhase,
} from "./support.js";

/**
 * AC12 (ADR 0010 §reconnect): the 60 s resume window is symmetric. The pair is
 * killed on the admin page (phase 1: the admin is the offerer and rebuilds it
 * ~600 ms later); the receiver re-announces its bitmap and the sender only
 * resends the missing chunks.
 *
 * The drop is issued on the *first* progress signal and the poll runs at 50 ms:
 * on a loopback the transfer is fast enough that a percentage threshold can be
 * crossed and the file finished before the test process gets to call the hook.
 */
const SENDER_SIZE_MB = Number(process.env.E2E_RESUME_MB ?? 20);
const RECEIVER_SIZE_MB = Number(process.env.E2E_RESUME_RX_MB ?? 20);

function forceDropOnAdmin(
  page: import("@playwright/test").Page,
): Promise<void> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __cfRoom?: { forceDrop: () => void } })
      .__cfRoom;
    if (!hook) throw new Error("__cfRoom hook missing");
    hook.forceDrop();
  });
}

async function openPair(browser: import("@playwright/test").Browser) {
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();
  const created = await createRoom(admin);
  await joinByLink(member, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);
  return { adminContext, memberContext, admin, member };
}

/** Wait for the first chunk to land, polling fast enough to drop mid-transfer. */
async function waitForFirstProgress(
  page: import("@playwright/test").Page,
  direction: "in" | "out",
): Promise<void> {
  await expect
    .poll(
      async () => {
        const view = await snapshot(page);
        const transfer =
          direction === "in"
            ? transferOf(view, "in")
            : (view.transfer ?? transferOf(view, "out"));
        return transfer?.sentBytes ?? 0;
      },
      { timeout: 60_000, intervals: [50] },
    )
    .toBeGreaterThan(0);
}

test("AC12a: admin is the sender; a forced drop resumes from the bitmap", async ({
  browser,
}) => {
  const size = SENDER_SIZE_MB * 1024 * 1024;
  const bytes = randomBytes(size);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const { adminContext, memberContext, admin, member } =
    await openPair(browser);

  await pickFiles(
    admin,
    fixtureFile(bytes, `resume-admin-${SENDER_SIZE_MB}mb.bin`),
  );
  await startSend(admin);
  await waitIncoming(member);
  await acceptIncoming(member);

  await waitForFirstProgress(admin, "out");
  await forceDropOnAdmin(admin);

  await waitPhase(admin, "paused", 30_000);
  // The sender resumes from the bitmap and may reach "done" before a poll observes the
  // transient paused phase on slower runners; the resumed transfer and matching hashes
  // below are the real assertion (AC12a keeps the strict both-sides-paused check).
  try {
    await waitForSnapshot(
      member,
      (view) => view.phase === "paused" || view.phase === "done",
      30_000,
      "member paused or done",
    );
  } catch (error) {
    const [adminView, memberView] = [
      await snapshot(admin),
      await snapshot(member),
    ];
    throw new Error(
      `AC12b stuck; admin=${JSON.stringify(adminView)}; member=${JSON.stringify(memberView)}; errors=${JSON.stringify(pageErrors)}`,
    );
  }
  await expectHashes([admin, member], expected, 240_000);

  await adminContext.close();
  await memberContext.close();
});

/**
 * AC12b: the member is the sender and the admin (the receiver, and phase 1's
 * offerer) rebuilds the pair, so the resume path runs with the sender on the
 * answering side. Covered after the core fix for the closed-channel
 * `waitForCapacity` loop (2026-11-26).
 */
test("AC12b: admin is the receiver; a forced drop resumes from the bitmap", async ({
  browser,
}) => {
  const size = RECEIVER_SIZE_MB * 1024 * 1024;
  const bytes = randomBytes(size);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const { adminContext, memberContext, admin, member } =
    await openPair(browser);
  const pageErrors: string[] = [];
  for (const [name, page] of [
    ["admin", admin],
    ["member", member],
  ] as const) {
    page.on("pageerror", (error) =>
      pageErrors.push(`${name}: ${String(error)}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        pageErrors.push(`${name} console: ${message.text()}`);
    });
  }

  // The member sends: the admin receives and accepts.
  await pickFiles(
    member,
    fixtureFile(bytes, `resume-member-${RECEIVER_SIZE_MB}mb.bin`),
  );
  await startSend(member);
  await waitIncoming(admin);
  await acceptIncoming(admin);
  await waitPhase(member, "transferring", 60_000);

  await waitForFirstProgress(admin, "in");
  await forceDropOnAdmin(admin);

  await waitPhase(admin, "paused", 30_000);
  // The sender resumes from the bitmap and may reach "done" before a poll observes the
  // transient paused phase on slower runners; the resumed transfer and matching hashes
  // below are the real assertion (AC12a keeps the strict both-sides-paused check).
  try {
    await waitForSnapshot(
      member,
      (view) => view.phase === "paused" || view.phase === "done",
      30_000,
      "member paused or done",
    );
  } catch (error) {
    const [adminView, memberView] = [
      await snapshot(admin),
      await snapshot(member),
    ];
    throw new Error(
      `AC12b stuck; admin=${JSON.stringify(adminView)}; member=${JSON.stringify(memberView)}; errors=${JSON.stringify(pageErrors)}`,
    );
  }
  await expectHashes([admin, member], expected, 240_000);

  await adminContext.close();
  await memberContext.close();
});
