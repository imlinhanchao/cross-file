import { expect, test, type Browser, type Page } from "@playwright/test";
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
} from "./support.js";

/**
 * Cancel / retry of a transfer (docs/02 §10.2 cancel note, v0.4.0).
 *
 * 1. A running 100 MB send is cancelled from the sending side: both pages end in
 *    the explicit `cancelled` state (never `error`), the receiver drops the
 *    half-received data, and 重试 re-sends the same file with a *new* transferId
 *    (fresh manifest/keys) until both sides report the expected SHA-256.
 * 2. A queued job can be cancelled locally, and cancelling the pair's active
 *    transfer makes the next queued job start on its own.
 */

const CANCEL_MB = Number(process.env.E2E_CANCEL_MB ?? 100);
const QUEUE_MB = Number(process.env.E2E_CANCEL_QUEUE_MB ?? 60);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Room {
  admin: Page;
  member: Page;
  adminContext: Awaited<ReturnType<Browser["newContext"]>>;
  memberContext: Awaited<ReturnType<Browser["newContext"]>>;
  errors: string[];
}

async function openRoom(browser: Browser): Promise<Room> {
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();
  const errors: string[] = [];
  for (const [name, page] of [
    ["admin", admin],
    ["member", member],
  ] as const) {
    page.on("pageerror", (error) => errors.push(`${name}: ${String(error)}`));
  }
  const created = await createRoom(admin);
  await joinByLink(member, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);
  return { admin, member, adminContext, memberContext, errors };
}

async function closeRoom(room: Room): Promise<void> {
  await room.adminContext.close();
  await room.memberContext.close();
}

test("cancel a running 100 MB send, then retry it with a fresh transferId", async ({
  browser,
}) => {
  const bytes = randomBytes(CANCEL_MB * 1024 * 1024);
  const expected = sha256(bytes);
  const room = await openRoom(browser);
  const { admin, member } = room;

  await pickFiles(admin, fixtureFile(bytes, `cancel-${CANCEL_MB}mb.bin`));
  await startSend(admin);
  const incoming = await waitIncoming(member);
  await acceptIncoming(member);

  // The transfer is really running (the receiver accepted and has bytes).
  await waitForSnapshot(
    member,
    (view) => (transferOf(view, "in")?.sentBytes ?? 0) > 0,
    60_000,
    "member is receiving bytes",
  );
  const cancelledId = incoming.transferId;
  expect(cancelledId).not.toBe("");

  // Cancel from the sending side.
  await admin.getByTestId("cancel-transfer").click();

  await waitForSnapshot(
    admin,
    (view) =>
      view.phase === "cancelled" && view.transfer?.cancelled === "local",
    30_000,
    "sender shows 已取消",
  );
  await waitForSnapshot(
    member,
    (view) => view.phase === "cancelled" && view.transfer?.cancelled === "peer",
    30_000,
    "receiver shows 对方已取消",
  );

  // A cancel is a normal end: no error, the receiver cleaned up its buffers and
  // the cancelled card offers a retry.
  for (const [label, page] of [
    ["admin", admin],
    ["member", member],
  ] as const) {
    const view = await snapshot(page);
    expect(view.error, `${label} must not report an error`).toBeUndefined();
    expect(view.incoming, `${label} cleans the consent card`).toBeUndefined();
  }
  await expect(admin.getByTestId("transfer-cancelled")).toBeVisible();
  await expect(admin.getByTestId("retry-transfer")).toBeVisible();
  await expect(member.getByTestId("cancel-transfer")).toHaveCount(0);

  // Retry: same files, same peer, brand-new transferId → new manifest + accept.
  await admin.getByTestId("retry-transfer").click();
  const retried = await waitIncoming(member);
  expect(retried.transferId).not.toBe(cancelledId);
  await acceptIncoming(member);
  await expectHashes([admin, member], expected, 180_000);

  expect(room.errors).toEqual([]);
  await closeRoom(room);
});

test("a queued job can be cancelled and the next job starts after the active transfer is cancelled", async ({
  browser,
}) => {
  const bigBytes = randomBytes(QUEUE_MB * 1024 * 1024);
  const firstBytes = randomBytes(2 * 1024 * 1024);
  const firstExpected = sha256(firstBytes);
  const secondBytes = randomBytes(3 * 1024 * 1024);

  const room = await openRoom(browser);
  const { admin, member } = room;

  // Admin sends a large file; the member receives it.
  await pickFiles(admin, fixtureFile(bigBytes, `queue-lead-${QUEUE_MB}mb.bin`));
  await startSend(admin);
  await waitIncoming(member);
  await acceptIncoming(member);
  await waitForSnapshot(
    member,
    (view) => (transferOf(view, "in")?.sentBytes ?? 0) > 0,
    60_000,
    "member is receiving the large file",
  );

  // Member queues two reverse jobs while the pair is busy.
  await pickFiles(member, {
    name: "queue-first.bin",
    mimeType: "application/octet-stream",
    buffer: firstBytes,
  });
  await member.getByTestId("start-send").click();
  await waitForSnapshot(
    member,
    (view) => view.queue.length === 1,
    30_000,
    "first reverse job queued",
  );
  await pickFiles(member, {
    name: "queue-second.bin",
    mimeType: "application/octet-stream",
    buffer: secondBytes,
  });
  await member.getByTestId("start-send").click();
  await waitForSnapshot(
    member,
    (view) => view.queue.length === 2,
    30_000,
    "second reverse job queued",
  );

  // Cancel the second (waiting) job: local removal, no transfer starts for it.
  await member.getByTestId("cancel-queue").last().click();
  await waitForSnapshot(
    member,
    (view) =>
      view.queue.length === 1 &&
      view.queue[0]?.files[0]?.name === "queue-first.bin",
    30_000,
    "only the first queued job remains",
  );

  // Cancel the pair's active transfer; the surviving queued job must start.
  // The receiver's "cancelled" phase can be replaced by the next job within a
  // frame, so the persistent sender-side card is the observable here.
  await admin.getByTestId("cancel-transfer").click();
  await waitForSnapshot(
    admin,
    (view) =>
      view.phase === "cancelled" && view.transfer?.cancelled === "local",
    30_000,
    "sender shows 已取消",
  );
  await waitForSnapshot(
    member,
    (view) => {
      const out = transferOf(view, "out");
      return Boolean(out && !out.cancelled);
    },
    60_000,
    "queued job starts after the cancel",
  );

  // The next job is the surviving one (never the cancelled second job).
  const incoming = await waitIncoming(admin);
  expect(incoming.files[0]?.name).toBe("queue-first.bin");
  expect(incoming.totalBytes).toBe(firstBytes.length);
  await acceptIncoming(admin);
  await expectHashes([admin, member], firstExpected, 120_000);
  // The big transfer was cancelled, never completed: the only digest on either
  // page is the surviving queued job's.
  const adminView = await snapshot(admin);
  expect(adminView.result?.sha256).toBe(firstExpected);

  expect(room.errors).toEqual([]);
  await closeRoom(room);
});
