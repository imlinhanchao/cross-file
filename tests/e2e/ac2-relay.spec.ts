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
} from "./support.js";

/**
 * AC2: force ICE onto TURN (relay-only) and prove the transfer still verifies.
 *
 * Requires a running coturn and a signaling server configured with TURN_URIS/TURN_SECRET:
 *   docker compose -f infra/docker-compose.yml up -d coturn
 *   TURN_SECRET=... TURN_URIS='turn:127.0.0.1:3478?transport=udp' E2E_RELAY=1 pnpm e2e
 * Without E2E_RELAY=1 this file is skipped so the default suite stays hermetic.
 */
test.skip(
  process.env.E2E_RELAY !== "1",
  "set E2E_RELAY=1 with coturn running to run the AC2 relay case",
);

const SIZE_MB = Number(process.env.E2E_RELAY_MB ?? 20);
const SIZE = SIZE_MB * 1024 * 1024;

test("AC2: relay-only (TURN) transfer of a file verifies end to end", async ({
  browser,
}) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const file = fixtureFile(bytes, `relay-${SIZE_MB}mb.bin`);

  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  // `?relay=1` is read by the controller: only TURN candidates are gathered.
  const created = await createRoom(admin, "relay=1");
  await joinByLink(member, created.link, "relay=1");
  await waitPending(admin);
  await admin.getByTestId("approve").click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);

  await pickFiles(admin, file);
  await startSend(admin);
  await waitIncoming(member);
  await acceptIncoming(member);

  await expectHashes([admin, member], expected);

  // Every path report must say relay: ICE was restricted to relay candidates.
  // The path label resolves from getStats shortly after the channels open, so poll it.
  await waitForSnapshot(
    admin,
    (view) => view.guests[0]?.path === "relay",
    30_000,
    "admin relay path",
  );
  await waitForSnapshot(
    member,
    (view) => view.transfer?.path === "relay",
    30_000,
    "member relay path",
  );

  await adminContext.close();
  await memberContext.close();
});
