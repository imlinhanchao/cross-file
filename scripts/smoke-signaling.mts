/**
 * End-to-end signaling smoke test (no browser): create → join → approve → signal → close.
 * Run: pnpm exec tsx scripts/smoke-signaling.mts
 */
import WebSocket from "ws";
import { createSignalingServer } from "../packages/signaling/src/index.ts";
import { base32Encode, randomBytes } from "../packages/core/src/bytes.ts";

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
} as const;

function client(port: number, label: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
  const messages: any[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(String(data));
    messages.push(message);
    console.log(`[${label}] <-`, message.type, JSON.stringify(message).slice(0, 120));
  });
  return {
    ws,
    messages,
    async open(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
    },
    send(message: unknown): void {
      ws.send(JSON.stringify(message));
    },
    async waitFor(type: string, timeoutMs = 3000): Promise<any> {
      const started = Date.now();
      for (;;) {
        const found = messages.find((m) => m.type === type);
        if (found) return found;
        if (Date.now() - started > timeoutMs) throw new Error(`${label}: timeout waiting for ${type}. got: ${messages.map((m) => m.type).join(",")}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}

const server = createSignalingServer({ port: 0, maxGuests: 4 });
const { port } = await server.start();
console.log(`signaling on :${port}`);

const host = client(port, "host");
const guest = client(port, "guest");
await host.open();
await guest.open();

const roomId = base32Encode(randomBytes(16));
host.send({ v: 1, type: "hello", clientCaps: caps });
host.send({ v: 1, type: "create", roomId, hostCaps: caps });
const created = await host.waitFor("created");
console.log("OK roomId", created.roomId, "code", created.code);

guest.send({ v: 1, type: "hello", clientCaps: caps });
guest.send({
  v: 1,
  type: "join",
  roomId,
  guestCaps: { ...caps, screen: "phone", platform: "ios", uaFamily: "safari" },
  guestNonce: "smoke-nonce-123",
});
const joinRequest = await host.waitFor("join_request");
console.log("OK join_request guestId", joinRequest.guestId);

host.send({ v: 1, type: "approve", guestId: joinRequest.guestId });
const [hostJoinOk, guestJoinOk] = await Promise.all([host.waitFor("join_ok"), guest.waitFor("join_ok")]);
console.log("OK join_ok host peerCaps", hostJoinOk.peerCaps.uaFamily, "guest peerCaps", guestJoinOk.peerCaps.uaFamily);

host.send({
  v: 1,
  type: "signal",
  to: joinRequest.guestId,
  payload: { k: "offer", sdp: "v=0\r\n" },
});
const offer = await guest.waitFor("signal");
console.log("OK host->guest signal", offer.payload.k, offer.from.length > 0);

guest.send({ v: 1, type: "signal", to: "host", payload: { k: "answer", sdp: "v=0\r\n" } });
const answer = await host.waitFor("signal");
console.log("OK guest->host sentinel signal", answer.payload.k);

host.send({ v: 1, type: "close", roomId });
const closed = await guest.waitFor("room_closed");
console.log("OK room_closed", closed.reason);

host.ws.close();
guest.ws.close();
await server.stop();
console.log("SMOKE PASS");
