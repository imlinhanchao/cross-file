import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  acceptIncoming,
  createRoom,
  expectHashes,
  joinByLink,
  others,
  PATH_LABELS,
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
 * AC16 (phase 2, docs/02 §11.1): admin + member A + member B. A → B and B → A
 * both transfer with a matching SHA-256 while neither end is the admin, proving
 * the lazy member↔member mesh works in both directions.
 *
 * The pair is cold at the start (no PC on member join: "lazy attach"), so the
 * first transfer is deliberately issued by the pair's **answerer** — the member
 * with the lexicographically larger memberId. That exercises the pair-request
 * wake (the answerer asks the elected offerer to create the PC), not just the
 * offerer-initiated path.
 */
const SIZE_MB = Number(process.env.E2E_MESH_MB ?? 2);
const SIZE = SIZE_MB * 1024 * 1024;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The file × member matrix only keeps the one receiver we want to test. */
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

test("AC16: member↔member transfers work in both directions over a lazy mesh", async ({
  browser,
}) => {
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
  await joinByLink(first, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();
  await waitOthersJoined(admin, 1);

  await joinByLink(second, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").first().click();

  await waitOthersJoined(admin, 2);
  await waitOthersJoined(first, 2);
  await waitOthersJoined(second, 2);

  const adminView = await snapshot(admin);
  const ids = others(adminView)
    .map((member) => member.id)
    .sort();
  expect(ids, "two members joined").toHaveLength(2);
  const [smallerId, largerId] = ids as [string, string];

  // Name the pages by the pair role so the first transfer is answerer-initiated.
  const firstView = await snapshot(first);
  const secondView = await snapshot(second);
  const answererPage = firstView.selfId === largerId ? first : second;
  const offererPage = answererPage === first ? second : first;
  const answererView = answererPage === first ? firstView : secondView;
  const offererView = answererPage === first ? secondView : firstView;
  const aId = answererView.selfId as string;
  const bId = offererView.selfId as string;
  expect(aId, "A is the answerer (larger memberId)").toBe(largerId);
  expect(bId, "B is the offerer (smaller memberId)").toBe(smallerId);
  expect(answererView.role, "A is a plain member, not the admin").toBe(
    "member",
  );
  expect(offererView.role, "B is a plain member, not the admin").toBe("member");

  // Lazy attach: joining did not create a peer connection, so no ICE path label
  // exists for any pair yet (only a connected pair reports one).
  expect(
    others(answererView).every((member) => !member.path),
    "no pair is created on member join (lazy attach)",
  ).toBe(true);

  // --- A → B: the answerer starts on a cold pair (pair-request wake) ---------
  const aBytes = randomBytes(SIZE);
  const aExpected = sha256(aBytes);
  await pickFiles(answererPage, {
    name: `ac16-a-${SIZE_MB}mb.bin`,
    mimeType: "application/octet-stream",
    buffer: aBytes,
  });
  await onlyReceiver(answererPage, await snapshot(answererPage), bId);
  await startSend(answererPage);

  const incomingAtB = await waitIncoming(offererPage);
  expect(incomingAtB.peerId, "the member↔member manifest comes from A").toBe(
    aId,
  );
  expect(incomingAtB.totalBytes).toBe(SIZE);
  await acceptIncoming(offererPage);
  await expectHashes([answererPage, offererPage], aExpected);

  // The ICE path resolves on both ends of the member↔member pair.
  await waitForSnapshot(
    answererPage,
    (view) => Boolean(view.members.find((m) => m.id === bId)?.path),
    30_000,
    "path label on A's side",
  );
  await waitForSnapshot(
    offererPage,
    (view) => Boolean(view.members.find((m) => m.id === aId)?.path),
    30_000,
    "path label on B's side",
  );
  expect(PATH_LABELS, "A's path label is a real ICE path").toContain(
    (await snapshot(answererPage)).members.find((m) => m.id === bId)?.path,
  );

  // The admin was not a party to the member↔member transfer.
  expect(
    (await snapshot(admin)).incoming,
    "admin never saw A→B",
  ).toBeUndefined();
  expect(
    Object.keys((await snapshot(admin)).transfers),
    "admin has no transfer for A→B",
  ).toEqual([]);

  // --- B → A: the reverse direction on the same pair -------------------------
  const bBytes = randomBytes(SIZE);
  const bExpected = sha256(bBytes);
  await pickFiles(offererPage, {
    name: `ac16-b-${SIZE_MB}mb.bin`,
    mimeType: "application/octet-stream",
    buffer: bBytes,
  });
  await onlyReceiver(offererPage, await snapshot(offererPage), aId);
  await startSend(offererPage);

  const incomingAtA = await waitIncoming(answererPage);
  expect(incomingAtA.peerId, "the reverse manifest comes from B").toBe(bId);
  expect(incomingAtA.totalBytes).toBe(SIZE);
  await acceptIncoming(answererPage);
  await expectHashes([offererPage, answererPage], bExpected);

  if (pageErrors.length > 0)
    console.log("PAGE ERRORS:", JSON.stringify(pageErrors, null, 2));
  expect(pageErrors).toEqual([]);

  await adminContext.close();
  await firstContext.close();
  await secondContext.close();
});
