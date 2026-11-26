import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import {
  createRoom,
  joinByLink,
  waitOthersJoined,
  waitPending,
  waitForSnapshot,
} from "./support.js";

const SIGNALING_PORT = Number(process.env.E2E_SIGNALING_PORT ?? 8790);

const CAPS = {
  platform: "linux",
  uaFamily: "chrome",
  nativeShell: false,
  secureContext: true,
  fsAccess: true,
  sw: true,
  swDownload: false,
  saveStrategies: ["fs", "blob"],
  screen: "desktop",
};

/** v2 join attempt against a room that should already be gone. */
function lateJoin(roomId: string): Promise<{ type: string; code?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}/v1/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no response from signaling"));
    }, 10_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ v: 2, type: "hello", clientCaps: CAPS }));
      ws.send(
        JSON.stringify({
          v: 2,
          type: "join",
          roomId,
          caps: CAPS,
          nonce: "late-join-nonce-1234",
        }),
      );
    });
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        type: string;
        code?: string;
      };
      if (
        message.type === "join_request" ||
        message.type === "join_rejected" ||
        message.type === "error"
      ) {
        clearTimeout(timer);
        ws.close();
        resolve(message);
      }
    });
    ws.on("error", reject);
  });
}

test("AC7: ending the room tears it down and later joins are rejected", async ({
  browser,
}) => {
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

  // "结束房间" destroys the room and the key, and the member is told immediately.
  await admin.getByRole("button", { name: "结束房间" }).click();
  await admin.getByTestId("dialog-confirm").click(); // confirm the destructive action
  await waitForSnapshot(
    member,
    (view) => view.phase === "error",
    30_000,
    "member sees the room close",
  );
  expect((await snapshotError(member)) ?? "").toContain("房间已结束");

  // The room is gone from server memory: a late join cannot find it.
  const response = await lateJoin(created.roomId);
  expect(response.type).not.toBe("join_request");
  expect(response.code ?? "").toMatch(/ROOM_NOT_FOUND|ROOM_CLOSED/);

  await adminContext.close();
  await memberContext.close();
});

async function snapshotError(
  page: import("@playwright/test").Page,
): Promise<string | undefined> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __crossfile?: { snapshot?: () => { error?: string } };
        }
      ).__crossfile?.snapshot?.().error,
  );
}
