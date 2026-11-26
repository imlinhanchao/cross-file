/**
 * End-to-end signaling smoke test (no browser, protocol v2): create → join → approve
 * → members broadcast → signal both ways → close.
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
    console.log(
      `[${label}] <-`,
      message.type,
      JSON.stringify(message).slice(0, 140),
    );
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
    async waitFor(
      type: string,
      predicate: (message: any) => boolean = () => true,
      timeoutMs = 3000,
    ): Promise<any> {
      const started = Date.now();
      for (;;) {
        const found = messages.find((m) => m.type === type && predicate(m));
        if (found) return found;
        if (Date.now() - started > timeoutMs)
          throw new Error(
            `${label}: timeout waiting for ${type}. got: ${messages.map((m) => m.type).join(",")}`,
          );
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}

const server = createSignalingServer({ port: 0, maxGuests: 4 });
const { port } = await server.start();
console.log(`signaling on :${port}`);

const admin = client(port, "admin");
const member = client(port, "member");
await admin.open();
await member.open();

const roomId = base32Encode(randomBytes(16));
admin.send({ v: 2, type: "hello", clientCaps: caps });
admin.send({ v: 2, type: "create", roomId, caps, name: "Smoke 管理员" });
const created = await admin.waitFor("created");
console.log("OK created roomId", created.roomId, "code", created.code);

member.send({ v: 2, type: "hello", clientCaps: caps });
member.send({
  v: 2,
  type: "join",
  roomId,
  caps: { ...caps, screen: "phone", platform: "ios", uaFamily: "safari" },
  nonce: "smoke-nonce-123",
});
const joinRequest = await admin.waitFor("join_request");
console.log("OK join_request memberId", joinRequest.memberId);

admin.send({ v: 2, type: "approve", memberId: joinRequest.memberId });
const [adminMembers, memberJoinOk] = await Promise.all([
  admin.waitFor("members", (message: any) =>
    message.members.some((entry: any) => entry.id === joinRequest.memberId),
  ),
  member.waitFor("join_ok"),
]);
console.log(
  "OK approved members",
  adminMembers.members.length,
  "member selfId",
  memberJoinOk.selfId,
);

member.send({ v: 2, type: "profile", name: "Smoke 成员" });
await admin.waitFor("members", (message: any) =>
  message.members.some((entry: any) => entry.name === "Smoke 成员"),
);
console.log("OK profile -> members broadcast");

admin.send({
  v: 2,
  type: "signal",
  to: joinRequest.memberId,
  payload: { k: "offer", sdp: "v=0\r\n" },
});
const offer = await member.waitFor("signal");
console.log("OK admin->member signal", offer.payload.k, offer.from.length > 0);

member.send({
  v: 2,
  type: "signal",
  to: created.selfId,
  payload: { k: "answer", sdp: "v=0\r\n" },
});
const answer = await admin.waitFor("signal");
console.log("OK member->admin signal", answer.payload.k);

admin.send({ v: 2, type: "close", roomId });
const closed = await member.waitFor("room_closed");
console.log("OK room_closed", closed.reason);

admin.ws.close();
member.ws.close();
await server.stop();

if (closed.reason !== "admin_close") {
  console.error("SMOKE FAIL: room_closed reason", closed.reason);
  process.exit(1);
}
console.log("SMOKE PASS");
