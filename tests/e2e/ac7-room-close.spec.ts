import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";

const SIGNALING_PORT = Number(process.env.E2E_SIGNALING_PORT ?? 8790);

interface Snapshot {
  phase: string;
  roomId?: string;
  code?: string;
  link?: string;
  guests: Array<{ id: string; status: string }>;
  error?: string;
  notice?: string;
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __crossfile?: { snapshot?: () => Snapshot } }).__crossfile;
    if (!hook?.snapshot) throw new Error("__crossfile hook missing");
    return hook.snapshot();
  });
}

function wsJoinExpect(roomId: string, caps: unknown): Promise<{ type: string; code?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}/v1/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no response from signaling"));
    }, 10_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ v: 1, type: "hello", clientCaps: caps }));
      ws.send(
        JSON.stringify({
          v: 1,
          type: "join",
          roomId,
          guestCaps: caps,
          guestNonce: "late-join-nonce-1234",
        }),
      );
    });
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { type: string; code?: string };
      if (message.type === "join_request" || message.type === "join_rejected" || message.type === "error") {
        clearTimeout(timer);
        ws.close();
        resolve(message);
      }
    });
    ws.on("error", reject);
  });
}

const caps = {
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

test("AC7: ending the room tears it down and later joins are rejected", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto("/");
  await expect.poll(async () => (await snapshot(host)).phase, { timeout: 30_000 }).toBe("waiting");
  const created = await snapshot(host);
  await guest.goto(created.link!);
  await expect.poll(async () => (await snapshot(host)).guests.length, { timeout: 30_000 }).toBe(1);
  await host.getByTestId("approve").click();
  await expect.poll(async () => (await snapshot(host)).guests[0]?.status, { timeout: 30_000 }).toBe("joined");

  // "结束房间" destroys the room and the key, and the guest is told immediately.
  await host.getByRole("button", { name: "结束房间" }).click();
  await expect.poll(async () => (await snapshot(guest)).phase, { timeout: 30_000 }).toBe("error");
  expect((await snapshot(guest)).error ?? "").toContain("房间已结束");

  // The room is gone from server memory: a late join cannot find it.
  const response = await wsJoinExpect(created.roomId!, caps);
  expect(response.type).not.toBe("join_request");
  expect(response.code ?? "").toMatch(/ROOM_NOT_FOUND|ROOM_CLOSED/);

  await hostContext.close();
  await guestContext.close();
});
