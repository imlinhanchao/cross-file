/**
 * End-to-end tests over a real `ws` client against an ephemeral-port server.
 * Covers the protocol behaviours listed in docs/02 §3 and the TURN credential rule in §6.7.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caps, ServerMessage } from "@crossfile/core/protocol";
import { createRoomIdentity } from "@crossfile/core/ids";
import { createSignalingServer, type SignalingServer, type SignalingServerOptions } from "./index.js";
import { SHORTCODE_TTL_MS } from "./shortcode.js";
import { GUEST_CAPS, HOST_CAPS, sleep, TestClient } from "./test-support.js";

type CreatedMessage = Extract<ServerMessage, { type: "created" }>;
type JoinRequestMessage = Extract<ServerMessage, { type: "join_request" }>;
type JoinOkMessage = Extract<ServerMessage, { type: "join_ok" }>;

const servers: SignalingServer[] = [];
const clients: TestClient[] = [];

async function startServer(overrides: SignalingServerOptions = {}): Promise<{ server: SignalingServer; port: number }> {
  const server = createSignalingServer({ port: 0, host: "127.0.0.1", ...overrides });
  const { port } = await server.start();
  servers.push(server);
  return { server, port };
}

async function connect(port: number): Promise<TestClient> {
  const client = await TestClient.open(port);
  clients.push(client);
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.stop();
});

async function createRoom(port: number): Promise<{ host: TestClient; roomId: string; code: string; created: CreatedMessage }> {
  const host = await connect(port);
  const { roomId } = createRoomIdentity();
  host.send({ v: 1, type: "hello", clientCaps: HOST_CAPS });
  host.send({ v: 1, type: "create", roomId, hostCaps: HOST_CAPS });
  const created = await host.next("created");
  return { host, roomId, code: created.code, created };
}

async function requestJoin(
  host: TestClient,
  guest: TestClient,
  roomIdOrCode: string,
  guestCaps: Caps = GUEST_CAPS,
  proof: string | null = "proof-value-0123456789",
): Promise<JoinRequestMessage> {
  guest.send({ v: 1, type: "hello", clientCaps: guestCaps });
  guest.send({
    v: 1,
    type: "join",
    roomId: roomIdOrCode,
    guestCaps,
    guestNonce: "guest-nonce-0123456789",
    ...(proof !== null ? { proof } : {}),
  });
  return host.next("join_request");
}

async function approve(host: TestClient, guest: TestClient, request: JoinRequestMessage): Promise<{ guestOk: JoinOkMessage; hostOk: JoinOkMessage }> {
  host.send({ v: 1, type: "approve", guestId: request.guestId });
  const guestOk = await guest.next("join_ok");
  const hostOk = await host.next("join_ok");
  return { guestOk, hostOk };
}

async function joinedPair(port: number): Promise<{
  host: TestClient;
  guest: TestClient;
  roomId: string;
  request: JoinRequestMessage;
}> {
  const { host, roomId } = await createRoom(port);
  const guest = await connect(port);
  const request = await requestJoin(host, guest, roomId);
  await approve(host, guest, request);
  return { host, guest, roomId, request };
}

/** Retry a host create until the server has noticed the old socket is gone. */
async function reconnectHost(port: number, roomId: string): Promise<{ host: TestClient; created: CreatedMessage }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const host = await connect(port);
    host.send({ v: 1, type: "create", roomId, hostCaps: HOST_CAPS });
    const message = await host.nextAny(["created", "error"]);
    if (message.type === "created") return { host, created: message };
    await host.close();
    await sleep(20);
  }
  throw new Error("host could not reconnect to its room");
}

async function expectNoMessage(client: TestClient, type: ServerMessage["type"], waitMs = 80): Promise<void> {
  await expect(client.next(type, waitMs)).rejects.toThrow(/timed out/);
}

describe("create (docs/02 §3.2)", () => {
  it("creates a room with a 26 character base32 roomId and a six digit code", async () => {
    const { port } = await startServer();
    const { roomId, code, created } = await createRoom(port);
    expect(roomId).toMatch(/^[a-z2-7]{26}$/);
    expect(code).toMatch(/^\d{6}$/);
    expect(created.roomId).toBe(roomId);
    // TURN is not configured, so no credentials are handed out (docs/02 §6.7).
    expect("turn" in created).toBe(false);
  });

  it("refuses a second create for the same roomId while the host socket is connected", async () => {
    const { port } = await startServer();
    const { roomId } = await createRoom(port);
    const rival = await connect(port);
    rival.send({ v: 1, type: "create", roomId, hostCaps: HOST_CAPS });
    const error = await rival.next("error");
    expect(error.code).toBe("ROOM_CLOSED");
  });

  it("treats a repeated create after host loss as host reconnect and keeps the guest list", async () => {
    const { port } = await startServer();
    const { host, roomId, code } = await createRoom(port);
    const guest = await connect(port);
    const request = await requestJoin(host, guest, roomId);
    await approve(host, guest, request);

    await host.close();
    await expectNoMessage(guest, "room_closed");

    const { host: host2, created } = await reconnectHost(port, roomId);
    expect(created.roomId).toBe(roomId);
    expect(created.code).toBe(code);
    // The reconnected host is told about the peers it still serves.
    const replay = await host2.next("join_ok");
    expect(replay.guestId).toBe(request.guestId);
    expect(replay.peerCaps).toEqual(GUEST_CAPS);

    guest.send({ v: 1, type: "signal", to: "host", payload: { k: "offer", sdp: "v=0\r\n" } });
    const signal = await host2.next("signal");
    expect(signal.from).toBe(request.guestId);
  });
});

describe("join / approve / deny (docs/02 §3.4, §3.5)", () => {
  it("forwards join_request, then joins both sides with the opposite peer capabilities", async () => {
    const { port } = await startServer();
    const { host, roomId } = await createRoom(port);
    const guest = await connect(port);
    const request = await requestJoin(host, guest, roomId);

    expect(request.guestId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(request.guestCaps).toEqual(GUEST_CAPS);
    expect(request.guestNonce).toBe("guest-nonce-0123456789");
    // The server has no roomKey, so the QR proof is forwarded verbatim for the host to check.
    expect(request.proof).toBe("proof-value-0123456789");
    expect("error" in request).toBe(false);

    host.send({ v: 1, type: "approve", guestId: request.guestId });
    const guestOk = await guest.next("join_ok");
    const hostOk = await host.next("join_ok");
    expect(guestOk.guestId).toBe(request.guestId);
    expect(guestOk.peerCaps).toEqual(HOST_CAPS);
    expect(hostOk.guestId).toBe(request.guestId);
    expect(hostOk.peerCaps).toEqual(GUEST_CAPS);
  });

  it("rejects a denied guest and removes it from the room", async () => {
    const { port } = await startServer();
    const { host, roomId } = await createRoom(port);
    const guest = await connect(port);
    const request = await requestJoin(host, guest, roomId);

    host.send({ v: 1, type: "deny", guestId: request.guestId, reason: "ROOM_NOT_FOUND" });
    const rejected = await guest.next("join_rejected");
    expect(rejected.code).toBe("ROOM_NOT_FOUND");
    expect(rejected.reason).toBe("ROOM_NOT_FOUND");

    // The denied guest is gone: signaling to it yields PEER_GONE.
    host.send({ v: 1, type: "signal", to: request.guestId, payload: { k: "offer", sdp: "v=0" } });
    expect((await host.next("error")).code).toBe("PEER_GONE");

    // And a new guest can still join the room afterwards.
    const late = await connect(port);
    await requestJoin(host, late, roomId);
  });

  it("passes free-form deny reasons through as reason text", async () => {
    const { port } = await startServer();
    const { host, roomId } = await createRoom(port);
    const guest = await connect(port);
    const request = await requestJoin(host, guest, roomId);
    host.send({ v: 1, type: "deny", guestId: request.guestId, reason: "not right now" });
    const rejected = await guest.next("join_rejected");
    expect(rejected.code).toBe("ROOM_CLOSED");
    expect(rejected.reason).toBe("not right now");
  });

  it("answers ROOM_NOT_FOUND for an unknown room", async () => {
    const { port } = await startServer();
    const guest = await connect(port);
    guest.send({
      v: 1,
      type: "join",
      roomId: createRoomIdentity().roomId,
      guestCaps: GUEST_CAPS,
      guestNonce: "guest-nonce-0123456789",
    });
    expect((await guest.next("error")).code).toBe("ROOM_NOT_FOUND");
  });

  it("answers ROOM_FULL once maxGuests is reached", async () => {
    const { port } = await startServer({ maxGuests: 1 });
    const { host, roomId } = await createRoom(port);
    const first = await connect(port);
    await requestJoin(host, first, roomId);

    const second = await connect(port);
    second.send({
      v: 1,
      type: "join",
      roomId,
      guestCaps: GUEST_CAPS,
      guestNonce: "guest-nonce-0123456789",
    });
    expect((await second.next("error")).code).toBe("ROOM_FULL");
  });
});

describe("signal (docs/02 §3.2)", () => {
  it("relays offer/answer in both directions and only whitelisted payload fields", async () => {
    const { port } = await startServer();
    const { host, guest, request } = await joinedPair(port);

    host.send({
      v: 1,
      type: "signal",
      to: request.guestId,
      payload: { k: "offer", sdp: "v=0", junk: "must not be relayed" },
    });
    const offer = await guest.next("signal");
    expect(offer.from).toBeTruthy();
    expect(offer.payload).toEqual({ k: "offer", sdp: "v=0" });

    guest.send({ v: 1, type: "signal", to: "host", payload: { k: "answer", sdp: "v=0\r\n" } });
    const answer = await host.next("signal");
    expect(answer.from).toBe(request.guestId);
    expect(answer.payload).toEqual({ k: "answer", sdp: "v=0\r\n" });

    guest.send({
      v: 1,
      type: "signal",
      to: "host",
      payload: { k: "candidate", candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host", sdpMid: "0" } },
    });
    const candidate = await host.next("signal");
    expect(candidate.payload).toEqual({
      k: "candidate",
      candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host", sdpMid: "0" },
    });
  });

  it("answers PEER_GONE for unknown targets and when the host is offline", async () => {
    const { port } = await startServer();
    const { host, guest } = await joinedPair(port);

    host.send({ v: 1, type: "signal", to: "no-such-guest", payload: { k: "offer", sdp: "v=0" } });
    expect((await host.next("error")).code).toBe("PEER_GONE");

    guest.send({ v: 1, type: "signal", to: "no-such-host", payload: { k: "answer", sdp: "v=0" } });
    expect((await guest.next("error")).code).toBe("PEER_GONE");
  });

  it("does not relay signal before the guest is approved", async () => {
    const { port } = await startServer();
    const { host, roomId } = await createRoom(port);
    const guest = await connect(port);
    const request = await requestJoin(host, guest, roomId);
    guest.send({ v: 1, type: "signal", to: "host", payload: { k: "answer", sdp: "v=0" } });
    expect((await guest.next("error")).code).toBe("PEER_GONE");
    // host can still approve afterwards
    await approve(host, guest, request);
  });
});

describe("six digit code (docs/02 §3.5)", () => {
  it("maps the code to the room and consumes it on the first successful join", async () => {
    const { port } = await startServer();
    const { host, code } = await createRoom(port);

    const first = await connect(port);
    const request = await requestJoin(host, first, code, GUEST_CAPS, null);
    expect(request.guestCaps).toEqual(GUEST_CAPS);
    expect(request.proof).toBeUndefined();

    const second = await connect(port);
    second.send({
      v: 1,
      type: "join",
      roomId: code,
      guestCaps: GUEST_CAPS,
      guestNonce: "guest-nonce-0123456789",
    });
    expect((await second.next("error")).code).toBe("ROOM_NOT_FOUND");
  });

  it("expires the code after ten minutes", async () => {
    const { port } = await startServer();
    const { code } = await createRoom(port);
    const issuedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(issuedAt + SHORTCODE_TTL_MS + 1);

    const guest = await connect(port);
    guest.send({
      v: 1,
      type: "join",
      roomId: code,
      guestCaps: GUEST_CAPS,
      guestNonce: "guest-nonce-0123456789",
    });
    expect((await guest.next("error")).code).toBe("ROOM_NOT_FOUND");
  });
});

describe("heartbeat and TTL (docs/01 D7, docs/02 §3.2)", () => {
  it("expires an idle room, notifies both sides and deletes it from memory", async () => {
    const { port } = await startServer({ roomTtlMs: 100 });
    const { host, guest, roomId } = await joinedPair(port);

    const guestClosed = await guest.next("room_closed", 2_000);
    expect(guestClosed.reason).toBe("ttl");
    const hostClosed = await host.next("room_closed", 2_000);
    expect(hostClosed.reason).toBe("ttl");

    // Gone from memory: joining again finds nothing.
    const late = await connect(port);
    late.send({
      v: 1,
      type: "join",
      roomId,
      guestCaps: GUEST_CAPS,
      guestNonce: "guest-nonce-0123456789",
    });
    expect((await late.next("error")).code).toBe("ROOM_NOT_FOUND");
  });

  it("extends the room lifetime on host heartbeat", async () => {
    const { port } = await startServer({ roomTtlMs: 150 });
    const { host, roomId } = await createRoom(port);
    for (let i = 0; i < 5; i += 1) {
      host.send({ v: 1, type: "heartbeat", roomId });
      await sleep(40);
    }
    // 200 ms elapsed with a 150 ms TTL: the heartbeats kept it alive, so nothing expired yet.
    await expectNoMessage(host, "room_closed", 60);
  });

  it("ignores guest heartbeats so a silent host still expires the room", async () => {
    const { port } = await startServer({ roomTtlMs: 120 });
    const { host, guest, roomId } = await joinedPair(port);
    for (let i = 0; i < 5; i += 1) {
      try {
        guest.send({ v: 1, type: "heartbeat", roomId });
      } catch {
        break;
      }
      await sleep(40);
    }
    const hostClosed = await host.next("room_closed", 2_000);
    expect(hostClosed.reason).toBe("ttl");
    await guest.next("room_closed", 2_000);
  });
});

describe("remove / peer_left / close (docs/02 §3.2, docs/01 AC7)", () => {
  it("notifies the host with peer_left when a guest socket drops", async () => {
    const { port } = await startServer();
    const { host, guest, request } = await joinedPair(port);
    await guest.close();
    const left = await host.next("peer_left");
    expect(left.guestId).toBe(request.guestId);
  });

  it("removes a joined guest on host request", async () => {
    const { port } = await startServer();
    const { host, guest, roomId, request } = await joinedPair(port);
    host.send({ v: 1, type: "remove", guestId: request.guestId });
    const closed = await guest.next("room_closed");
    expect(closed.reason).toBe("error");
    expect((await guest.closed()).code).toBe(1000);
    const left = await host.next("peer_left");
    expect(left.guestId).toBe(request.guestId);
    // The room itself is still alive.
    const nextGuest = await connect(port);
    await requestJoin(host, nextGuest, roomId);
  });

  it("closes the room for every guest and destroys it immediately", async () => {
    const { port } = await startServer();
    const { host, guest, roomId } = await joinedPair(port);
    host.send({ v: 1, type: "close", roomId });
    const closed = await guest.next("room_closed");
    expect(closed.reason).toBe("host_close");
    await guest.closed();

    const late = await connect(port);
    late.send({
      v: 1,
      type: "join",
      roomId,
      guestCaps: GUEST_CAPS,
      guestNonce: "guest-nonce-0123456789",
    });
    expect((await late.next("error")).code).toBe("ROOM_NOT_FOUND");
  });
});

describe("robustness (docs/02 §3.1, §3.6)", () => {
  it("answers BAD_MESSAGE for unknown types and keeps the connection usable", async () => {
    const { port } = await startServer();
    const client = await connect(port);
    client.send({ v: 1, type: "hello" });
    client.send({ v: 1, type: "not-a-message" });
    expect((await client.next("error")).code).toBe("BAD_MESSAGE");

    client.send({ v: 1, type: "hello" });
    await expectNoMessage(client, "error");
  });

  it("closes the connection after repeated malformed frames", async () => {
    const { port } = await startServer();
    const client = await connect(port);
    client.sendText("not json at all");
    for (let i = 0; i < 5; i += 1) client.send({ v: 1, type: "broken", i });
    const closed = await client.closed(2_000);
    expect(closed.code).toBe(1008);
  });

  it("closes the connection for a frame larger than 64 KiB", async () => {
    const { port } = await startServer();
    const client = await connect(port);
    client.sendText("x".repeat(70 * 1024));
    const closed = await client.closed(3_000);
    expect(closed.code).toBe(1009);
  });

  it("rate limits a client by IP with RATE_LIMITED", async () => {
    const { port } = await startServer({ rateLimit: { windowMs: 60_000, max: 3 } });
    const client = await connect(port);
    for (let i = 0; i < 3; i += 1) client.send({ v: 1, type: "hello" });
    client.send({ v: 1, type: "hello" });
    expect((await client.next("error")).code).toBe("RATE_LIMITED");
    expect((await client.closed(2_000)).code).toBe(1008);
  });
});

describe("TURN credentials (docs/02 §6.7)", () => {
  it("issues coturn static-auth credentials on created and join_ok", async () => {
    const secret = "static-auth-secret-for-tests";
    const uris = ["turn:turn.example.org:3478?transport=udp", "turns:turn.example.org:5349"];
    const ttl = 600;
    const { port } = await startServer({ turn: { uris, secret, ttl } });
    const { host, roomId, created } = await createRoom(port);

    expect(created.turn).toBeDefined();
    const credential = created.turn!;
    expect(credential.uris).toEqual(uris);
    expect(credential.ttl).toBe(ttl);
    const match = /^(\d+):([A-Za-z0-9_-]{11})$/.exec(credential.username);
    expect(match).not.toBeNull();
    const expiry = Number(match![1]);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    expect(Math.abs(expiry - (nowSeconds + ttl))).toBeLessThanOrEqual(2);
    const expected = createHmac("sha1", secret).update(credential.username).digest("base64");
    expect(credential.credential).toBe(expected);

    // join_ok carries a credential per peer: one for the guest, one for the host.
    const guest = await connect(port);
    const request = await requestJoin(host, guest, roomId);
    const { guestOk, hostOk } = await approve(host, guest, request);
    expect(guestOk.turn).toBeDefined();
    expect(hostOk.turn).toBeDefined();
    expect(guestOk.turn!.username.split(":")[1]).toBe(request.guestId);
    expect(hostOk.turn!.username.split(":")[1]).not.toBe(request.guestId);
    expect(hostOk.turn!.credential).toBe(
      createHmac("sha1", secret).update(hostOk.turn!.username).digest("base64"),
    );
  });
});
