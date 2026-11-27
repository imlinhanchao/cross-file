import { expect, test, type Browser } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  acceptIncoming,
  createRoom,
  expectHashes,
  joinByLink,
  others,
  pickFiles,
  snapshot,
  startSend,
  waitForSnapshot,
  waitIncoming,
  waitOthersJoined,
  waitPending,
  type Snapshot,
} from "./support.js";

/**
 * AC17 (phase 2, docs/02 §11.2 / ADR 0010 D24): when the admin stays offline for
 * the whole reconnect window, the server promotes the earliest-joined online
 * member. Both remaining pages must see the new admin, the promoted page must
 * get the admin UI and be able to keep sending/receiving, and a late joiner must
 * be approved by the new admin. AC17b covers the returning old admin: its
 * `create` is refused after the hand-over and the page must offer the normal
 * join flow instead of a dead end.
 *
 * Both specs are skipped unless `E2E_RECONNECT_MS` is set: they need the
 * server's hand-over window shortened (the harness forwards it as
 * RECONNECT_WINDOW_MS) — run with
 * `E2E_RECONNECT_MS=1500 pnpm exec playwright test tests/e2e/ac17-*.spec.ts`.
 */
const RECONNECT_MS = Number(process.env.E2E_RECONNECT_MS ?? "");
const HANDOVER_TIMEOUT =
  (Number.isFinite(RECONNECT_MS) ? RECONNECT_MS : 0) + 60_000;
const SIZE = 1024 * 1024;

test.skip(
  !Number.isFinite(RECONNECT_MS) || RECONNECT_MS <= 0,
  "E2E_RECONNECT_MS is unset: the admin-handover specs need a short server reconnect window (run with E2E_RECONNECT_MS=1500)",
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Only keep the wanted receiver in the file × member matrix. */
async function onlyReceiver(
  page: import("@playwright/test").Page,
  view: Snapshot,
  receiverId: string,
): Promise<void> {
  for (const member of others(view)) {
    if (member.id === receiverId) continue;
    if ((view.assignments["1"] ?? []).includes(member.id)) {
      await page.getByTestId(`assign-1-${member.id}`).click();
    }
  }
  await waitForSnapshot(
    page,
    (next) =>
      (next.assignments["1"] ?? []).length === 1 &&
      (next.assignments["1"] ?? [])[0] === receiverId,
    30_000,
    "matrix has exactly one receiver",
  );
}

/** Admin + A (joined first) + B (joined second); all three pair up. */
async function openThreeMemberRoom(browser: Browser) {
  const adminContext = await browser.newContext();
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  const created = await createRoom(admin);

  // A joins first, then B: join order decides who inherits the admin role.
  await joinByLink(a, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 1);

  await joinByLink(b, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 2);
  await waitOthersJoined(a, 2);
  await waitOthersJoined(b, 2);

  const adminId = (await snapshot(admin)).selfId as string;
  const aId = (await snapshot(a)).selfId as string;
  const bId = (await snapshot(b)).selfId as string;
  return {
    adminContext,
    aContext,
    bContext,
    admin,
    a,
    b,
    created,
    adminId,
    aId,
    bId,
  };
}

test("AC17: the earliest-joined member takes over when the admin stays offline", async ({
  browser,
}) => {
  const {
    adminContext,
    aContext,
    bContext,
    admin,
    a,
    b,
    created,
    adminId,
    aId,
    bId,
  } = await openThreeMemberRoom(browser);
  const pageErrors: string[] = [];
  for (const [name, page] of [
    ["admin", admin],
    ["a", a],
    ["b", b],
  ] as const) {
    page.on("pageerror", (error) =>
      pageErrors.push(`${name}: ${String(error)}`),
    );
  }
  expect(
    others(await snapshot(admin))
      .map((member) => member.id)
      .sort(),
    "A and B joined",
  ).toEqual([aId, bId].sort());
  expect((await snapshot(a)).role, "A starts as a member").toBe("member");

  // A fourth device knocks while the admin is still online: it is left pending,
  // so the server must replay its join_request to the promoted admin.
  const pendingContext = await browser.newContext();
  const pendingMember = await pendingContext.newPage();
  await joinByLink(pendingMember, created.link);
  const pendingId = await waitPending(admin);

  // The admin disappears for longer than the reconnect window (page close also
  // closes the signaling socket, so the server starts its hand-over timer).
  await adminContext.close();

  // The earliest-joined online member (A) is promoted; the old admin is gone.
  await waitForSnapshot(
    a,
    (view) =>
      view.role === "admin" &&
      view.members.some((member) => member.id === aId && member.isAdmin) &&
      !view.members.some((member) => member.id === adminId),
    HANDOVER_TIMEOUT,
    "A is promoted to admin",
  );
  await waitForSnapshot(
    b,
    (view) =>
      view.members.some((member) => member.id === aId && member.isAdmin) &&
      !view.members.some((member) => member.id === adminId),
    HANDOVER_TIMEOUT,
    "B sees A as the new admin",
  );

  // Admin badge/role in the UI, and a clear notice on both remaining pages.
  await expect(a.getByTestId("self-chip")).toHaveAttribute(
    "data-role",
    "admin",
  );
  await expect(b.getByTestId("self-chip")).toHaveAttribute(
    "data-role",
    "member",
  );
  await expect(a.getByTestId("handover-notice")).toBeVisible();
  await expect(b.getByTestId("handover-notice")).toBeVisible();

  // The promoted admin received the room via `created` (unchanged 6-digit code,
  // fresh rejoin token), so the admin-only invite/code panel is populated.
  const promoted = await snapshot(a);
  expect(promoted.code, "the new admin knows the unchanged room code").toMatch(
    /^[0-9]{6}$/,
  );
  expect(promoted.link, "the new admin has the invite link").toContain("#");

  // The pending request was replayed: the new admin approves it.
  const replayedId = await waitPending(a, 30_000);
  expect(replayedId, "pending join_request replayed to the new admin").toBe(
    pendingId,
  );
  await a.getByTestId("approve").first().click();
  await waitForSnapshot(
    pendingMember,
    (view) => view.phase === "joined",
    60_000,
    "replayed pending joiner approved",
  );

  // --- the new admin can still send a file -----------------------------------
  const aBytes = randomBytes(SIZE);
  const aExpected = sha256(aBytes);
  await pickFiles(a, {
    name: "ac17-new-admin.bin",
    mimeType: "application/octet-stream",
    buffer: aBytes,
  });
  await onlyReceiver(a, await snapshot(a), bId);
  await startSend(a);
  const incomingAtB = await waitIncoming(b);
  expect(incomingAtB.peerId).toBe(aId);
  await acceptIncoming(b);
  await expectHashes([a, b], aExpected);

  // --- ...and still receive one ----------------------------------------------
  const bBytes = randomBytes(SIZE);
  const bExpected = sha256(bBytes);
  await pickFiles(b, {
    name: "ac17-reverse.bin",
    mimeType: "application/octet-stream",
    buffer: bBytes,
  });
  await onlyReceiver(b, await snapshot(b), aId);
  await startSend(b);
  const incomingAtA = await waitIncoming(a);
  expect(incomingAtA.peerId).toBe(bId);
  await acceptIncoming(a);
  await expectHashes([b, a], bExpected);

  // --- a late joiner is approved by the new admin ----------------------------
  const lateContext = await browser.newContext();
  const late = await lateContext.newPage();
  late.on("pageerror", (error) => pageErrors.push(`late: ${String(error)}`));
  await joinByLink(late, created.link);
  const lateId = await waitPending(a);
  expect(lateId, "new admin receives the late join request").toBeTruthy();
  await a.getByTestId("approve").first().click();
  await waitForSnapshot(
    late,
    (view) =>
      view.phase === "joined" &&
      view.members.some((member) => member.id === aId && member.isAdmin),
    60_000,
    "late joiner approved by the new admin",
  );
  await waitForSnapshot(
    b,
    (view) => view.members.some((member) => member.id === lateId),
    30_000,
    "B sees the late joiner",
  );

  if (pageErrors.length > 0)
    console.log("PAGE ERRORS:", JSON.stringify(pageErrors, null, 2));
  expect(pageErrors).toEqual([]);

  await aContext.close();
  await bContext.close();
  await pendingContext.close();
  await lateContext.close();
});

test("AC17b: the old admin returns as a fresh joiner after the hand-over", async ({
  browser,
}) => {
  const { adminContext, aContext, bContext, admin, a, b, adminId, aId } =
    await openThreeMemberRoom(browser);

  // Keep the old admin's page alive but take its socket offline long enough for
  // the hand-over: blocking reconnects is what makes the window matter.
  await adminContext.setOffline(true);
  await admin.evaluate(() => {
    const hook = (
      window as unknown as { __cfRoom?: { socket?: { close(): void } } }
    ).__cfRoom;
    if (!hook?.socket) throw new Error("__cfRoom.socket hook missing");
    hook.socket.close();
  });
  await waitForSnapshot(
    a,
    (view) =>
      view.role === "admin" &&
      !view.members.some((member) => member.id === adminId),
    HANDOVER_TIMEOUT,
    "A is promoted while the old admin is offline",
  );

  // Back online: the reconnect `create` for the old room is refused. The page
  // must explain it and offer the normal join flow, not strand the user.
  await adminContext.setOffline(false);
  await waitForSnapshot(
    admin,
    (view) => view.rejoinLost === true && view.phase === "error",
    60_000,
    "old admin sees the rejoin dead-end",
  );
  await expect(admin.getByTestId("rejoin-room")).toBeVisible();
  await admin.getByTestId("rejoin-room").click();

  // The normal join flow: a fresh `join_request` approved by the new admin.
  const rejoinedId = await waitPending(a);
  expect(rejoinedId, "the returning old admin asks to join").toBeTruthy();
  await a.getByTestId("approve").first().click();
  await waitForSnapshot(
    admin,
    (view) =>
      view.phase === "joined" &&
      view.role === "member" &&
      view.members.some((member) => member.id === aId && member.isAdmin) &&
      view.members.some((member) => member.id === rejoinedId),
    60_000,
    "the old admin is back as an approved member",
  );
  // It is a brand-new member identity, not the old admin one.
  expect((await snapshot(admin)).selfId).not.toBe(adminId);

  await aContext.close();
  await bContext.close();
  await adminContext.close();
});
