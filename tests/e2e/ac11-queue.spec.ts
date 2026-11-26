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
 * AC11 (ADR 0010 §concurrency): one active transfer per pair, either direction.
 * While the admin is sending, the member may pick files and press send; the job
 * must queue (BUSY on the wire, "已排队" locally) and start automatically once the
 * pair is idle. The two directions must never run at the same time.
 *
 * The first file is deliberately large (~80 MB) to leave time to queue the reverse
 * direction on a fast loopback.
 */
const SIZE_MB = Number(process.env.E2E_QUEUE_MB ?? 80);
const SIZE = SIZE_MB * 1024 * 1024;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("AC11: a reverse send during an active transfer queues and starts afterwards", async ({
  browser,
}) => {
  const adminBytes = randomBytes(SIZE);
  const adminExpected = sha256(adminBytes);
  const memberBytes = randomBytes(1024 * 1024);
  const memberExpected = sha256(memberBytes);

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

  // 1. Admin starts the large transfer; the member accepts and is receiving.
  await pickFiles(admin, fixtureFile(adminBytes, `queue-${SIZE_MB}mb.bin`));
  await startSend(admin);
  await waitIncoming(member);
  await acceptIncoming(member);
  await waitPhase(admin, "transferring", 60_000);
  await waitForSnapshot(
    member,
    (view) => Boolean(transferOf(view, "in")),
    60_000,
    "member is receiving",
  );

  // 2. Member starts the reverse direction while the pair is busy: it must queue.
  await pickFiles(member, {
    name: "queue-reverse.bin",
    mimeType: "application/octet-stream",
    buffer: memberBytes,
  });
  await member.getByTestId("start-send").click();
  await waitForSnapshot(
    member,
    (view) => view.queue.length > 0,
    30_000,
    "reverse transfer is queued",
  );
  await expect(member.getByTestId("queue-item")).toBeVisible();

  const queued = await snapshot(member);
  expect(queued.queue).toHaveLength(1);
  // Same-pair serial rule: while receiving there must be no outgoing transfer yet.
  expect(transferOf(queued, "out")).toBeUndefined();
  expect(transferOf(queued, "in")).toBeDefined();

  // 3. The admin's transfer completes; the member keeps the digest of what it received.
  await waitForSnapshot(
    member,
    (view) => view.result?.sha256 === adminExpected,
    180_000,
    "member received the admin file",
  );
  // Once the first transfer finishes the queue flushes immediately, so the
  // queue entry may already be gone here; the serial guarantee was asserted
  // on the mid-transfer snapshot above.

  // 4. The queued job starts on its own once the pair is idle.
  await waitForSnapshot(
    member,
    (view) => Boolean(transferOf(view, "out")),
    60_000,
    "queued reverse transfer starts",
  );
  const incomingAtAdmin = await waitIncoming(admin);
  expect(incomingAtAdmin.totalBytes).toBe(memberBytes.length);
  await acceptIncoming(admin);
  await expectHashes([admin, member], memberExpected);

  if (pageErrors.length > 0)
    console.log("PAGE ERRORS:", JSON.stringify(pageErrors, null, 2));
  expect(pageErrors).toEqual([]);

  await adminContext.close();
  await memberContext.close();
});
