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
  waitIncoming,
  waitOthersJoined,
  waitPending,
} from "./support.js";

/**
 * Receiver-side capability gate (docs/01 §6, D16): an iPhone-class receiver with a
 * 100 MB soft limit must see a warning before accepting a 150 MB file, and the
 * transfer must still verify when the user chooses "仍要接收".
 */
const SIZE_MB = 150;
const SIZE = SIZE_MB * 1024 * 1024;

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";

test("capability gate: iPhone-class receiver warns above its 100 MB soft limit", async ({
  browser,
}) => {
  const bytes = randomBytes(SIZE);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const file = fixtureFile(bytes, `cap-${SIZE_MB}mb.bin`);

  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();

  // Make the member look like an iPhone to capability detection (no FSA picker).
  await member.addInitScript((ua) => {
    Object.defineProperty(navigator, "userAgent", { get: () => ua });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
    Object.defineProperty(window, "showSaveFilePicker", {
      get: () => undefined,
    });
  }, IPHONE_UA);

  const created = await createRoom(admin);
  await joinByLink(member, created.link);
  await waitPending(admin);
  await admin.getByTestId("approve").click();
  await waitOthersJoined(admin, 1);
  await waitOthersJoined(member, 1);

  await pickFiles(admin, file);
  await startSend(admin);
  // The sender's own capability gate warns first and asks for confirmation.
  await admin.getByTestId("dialog-confirm").click({ timeout: 30_000 });

  const incoming = await waitIncoming(member);
  // The member judges the manifest against its own caps: iOS -> 100 MB soft limit.
  expect(incoming.risk?.level).toBe("warn");
  expect(incoming.risk?.softLimitMB).toBe(100);
  await expect(member.getByTestId("accept")).toHaveText(/仍要接收/);

  // Above the soft limit the member must confirm in a dialog before accepting.
  await acceptIncoming(member, { riskConfirm: true });
  await expectHashes([admin, member], expected, 240_000);

  expect((await snapshot(member)).risk?.level).toBe("warn");

  await adminContext.close();
  await memberContext.close();
});
