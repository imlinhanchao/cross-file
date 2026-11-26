/**
 * End-to-end tests over a real `ws` client against an ephemeral-port server (v2, ADR 0010).
 * Covers the room protocol in docs/02 §3 (admin + members, members broadcast, any-to-any
 * signal, rejoinToken), the TURN credential rule in §6.8 and the version gate.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caps, MemberInfo, ServerMessage } from "@crossfile/core/protocol";
import { createRoomIdentity } from "@crossfile/core/ids";
import {
  createSignalingServer,
  type SignalingServer,
  type SignalingServerOptions,
} from "./index.js";
import { SHORTCODE_TTL_MS } from "./shortcode.js";
import { ADMIN_CAPS, MEMBER_CAPS, sleep, TestClient } from "./test-support.js";

type CreatedMessage = Extract<ServerMessage, { type: "created" }>;
type JoinRequestMessage = Extract<ServerMessage, { type: "join_request" }>;
type JoinOkMessage = Extract<ServerMessage, { type: "join_ok" }>;
type MembersMessage = Extract<ServerMessage, { type: "members" }>;

const servers: SignalingServer[] = [];
const clients: TestClient[] = [];

async function startServer(
  overrides: SignalingServerOptions = {},
): Promise<{ server: SignalingServer; port: number }> {
  const server = createSignalingServer({
    port: 0,
    host: "127.0.0.1",
    ...overrides,
  });
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

function memberNamed(members: MemberInfo[], id: string): MemberInfo {
  const found = members.find((member) => member.id === id);
  if (!found) throw new Error(`member ${id} is not in the room`);
  return found;
}

async function createRoom(
  port: number,
  options: { name?: string; caps?: Caps; roomId?: string } = {},
): Promise<{
  admin: TestClient;
  roomId: string;
  code: string;
  created: CreatedMessage;
}> {
  const admin = await connect(port);
  const roomId = options.roomId ?? createRoomIdentity().roomId;
  const caps = options.caps ?? ADMIN_CAPS;
  admin.send({ v: 2, type: "hello", clientCaps: caps });
  admin.send({
    v: 2,
    type: "create",
    roomId,
    caps,
    name: options.name ?? "MacBook · 7K2F",
  });
  const created = await admin.next("created");
  return { admin, roomId, code: created.code, created };
}

async function requestJoin(
  admin: TestClient,
  member: TestClient,
  roomIdOrCode: string,
  options: {
    caps?: Caps;
    proof?: string | null;
    nonce?: string;
  } = {},
): Promise<JoinRequestMessage> {
  const caps = options.caps ?? MEMBER_CAPS;
  const proof =
    options.proof === undefined ? "proof-value-0123456789" : options.proof;
  member.send({ v: 2, type: "hello", clientCaps: caps });
  member.send({
    v: 2,
    type: "join",
    roomId: roomIdOrCode,
    caps,
    nonce: options.nonce ?? "member-nonce-0123456789",
    ...(proof !== null ? { proof } : {}),
  });
  return admin.next("join_request");
}

/** Approve a pending member; consumes the broadcast each side receives. */
async function approve(
  admin: TestClient,
  member: TestClient,
  request: JoinRequestMessage,
): Promise<{
  joinOk: JoinOkMessage;
  adminView: MemberInfo[];
  memberView: MemberInfo[];
}> {
  admin.send({ v: 2, type: "approve", memberId: request.memberId });
  const joinOk = await member.next("join_ok");
  const memberMembers = await member.next("members");
  const adminMembers = await admin.next("members");
  return {
    joinOk,
    adminView: adminMembers.members,
    memberView: memberMembers.members,
  };
}

async function joinedPair(
  port: number,
  options: { adminName?: string; memberCaps?: Caps } = {},
): Promise<{
  admin: TestClient;
  member: TestClient;
  roomId: string;
  created: CreatedMessage;
  request: JoinRequestMessage;
  joinOk: JoinOkMessage;
}> {
  const { admin, roomId, created } = await createRoom(port, {
    ...(options.adminName ? { name: options.adminName } : {}),
  });
  const member = await connect(port);
  const request = await requestJoin(admin, member, roomId, {
    ...(options.memberCaps ? { caps: options.memberCaps } : {}),
  });
  const { joinOk } = await approve(admin, member, request);
  return { admin, member, roomId, created, request, joinOk };
}

/** Reconnect a member with its rejoinToken; returns the fresh join_ok. */
async function rejoin(
  port: number,
  roomId: string,
  rejoinToken: string,
): Promise<{ client: TestClient; joinOk: JoinOkMessage }> {
  const client = await connect(port);
  client.send({
    v: 2,
    type: "join",
    roomId,
    caps: MEMBER_CAPS,
    nonce: "rejoin-nonce-0123456789",
    rejoinToken,
  });
  const joinOk = await client.next("join_ok");
  return { client, joinOk };
}

async function expectNoMessage(
  client: TestClient,
  type: ServerMessage["type"],
  waitMs = 80,
): Promise<void> {
  await expect(client.next(type, waitMs)).rejects.toThrow(/timed out/);
}

describe("create (docs/02 §3.2, ADR 0010)", () => {
  it("creates a room whose creator is the admin", async () => {
    const { port } = await startServer();
    const { roomId, code, created } = await createRoom(port);
    expect(roomId).toMatch(/^[a-z2-7]{26}$/);
    expect(code).toMatch(/^\d{6}$/);
    expect(created.roomId).toBe(roomId);
    expect(created.selfId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(created.name).toBe("MacBook · 7K2F");
    expect(created.rejoinToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.members).toHaveLength(1);
    expect(created.members[0]).toMatchObject({
      id: created.selfId,
      name: "MacBook · 7K2F",
      isAdmin: true,
      state: "joined",
    });
    expect(created.members[0]!.caps).toEqual(ADMIN_CAPS);
    // TURN is not configured, so no credentials are handed out (docs/02 §6.8).
    expect("turn" in created).toBe(false);
  });

  it("trims and normalises the admin display name", async () => {
    const { port } = await startServer();
    const { created } = await createRoom(port, { name: "  客厅 的电脑  " });
    expect(created.name).toBe("客厅 的电脑");
    expect(created.members[0]!.name).toBe("客厅 的电脑");
  });

  it("rejects an invalid admin display name with BAD_MESSAGE", async () => {
    const { port } = await startServer();
    const admin = await connect(port);
    admin.send({
      v: 2,
      type: "create",
      roomId: createRoomIdentity().roomId,
      caps: ADMIN_CAPS,
      name: "   ",
    });
    expect((await admin.next("error")).code).toBe("BAD_MESSAGE");

    admin.send({
      v: 2,
      type: "create",
      roomId: createRoomIdentity().roomId,
      caps: ADMIN_CAPS,
      name: "一二三四五六七八九十一二三四五六七",
    });
    expect((await admin.next("error")).code).toBe("BAD_MESSAGE");
  });

  it("refuses a second create for the same roomId while the admin is connected", async () => {
    const { port } = await startServer();
    const { roomId } = await createRoom(port);
    const rival = await connect(port);
    rival.send({
      v: 2,
      type: "create",
      roomId,
      caps: ADMIN_CAPS,
      name: "rival",
    });
    expect((await rival.next("error")).code).toBe("ROOM_CLOSED");
  });

  it("treats a repeated create after admin loss as a reconnect and keeps members", async () => {
    const { port } = await startServer();
    const { admin, member, roomId, created, request } = await joinedPair(port);

    await admin.close();
    // Members see the admin drop as an offline entry, not as a closed room.
    const offlineView = await member.next("members");
    expect(memberNamed(offlineView.members, created.selfId).state).toBe(
      "offline",
    );
    await expectNoMessage(member, "room_closed");

    const host2 = await connect(port);
    host2.send({
      v: 2,
      type: "create",
      roomId,
      caps: ADMIN_CAPS,
      name: "MacBook · 7K2F",
    });
    const created2 = await host2.next("created");
    expect(created2.roomId).toBe(roomId);
    expect(created2.code).toBe(created.code);
    expect(created2.selfId).toBe(created.selfId);
    expect(created2.members.map((entry) => entry.id)).toContain(
      request.memberId,
    );

    // The admin socket gets the same full snapshot the members get.
    const adminView = await host2.next("members");
    expect(memberNamed(adminView.members, request.memberId).state).toBe(
      "joined",
    );
    const memberView = await member.next("members");
    expect(memberNamed(memberView.members, created.selfId).state).toBe(
      "joined",
    );

    member.send({
      v: 2,
      type: "signal",
      to: created.selfId,
      payload: { k: "offer", sdp: "v=0\r\n" },
    });
    const signal = await host2.next("signal");
    expect(signal.from).toBe(request.memberId);
  });

  it("rejects a v1 connection with VERSION_MISMATCH and closes it", async () => {
    const { port } = await startServer();
    const stale = await connect(port);
    stale.send({ v: 1, type: "hello" });
    const error = await stale.next("error");
    expect(error.code).toBe("VERSION_MISMATCH");
    expect(error.msg).toContain("刷新");
    const closed = await stale.closed(2_000);
    expect(closed.code).toBe(1008);
  });
});

describe("join / approve / deny (docs/02 §3.4, §3.5)", () => {
  it("forwards join_request with a default name, caps, nonce and proof", async () => {
    const { port } = await startServer();
    const { admin, roomId } = await createRoom(port);
    const member = await connect(port);
    const request = await requestJoin(admin, member, roomId);

    expect(request.memberId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(request.caps).toEqual(MEMBER_CAPS);
    expect(request.nonce).toBe("member-nonce-0123456789");
    // The server has no roomKey, so the QR proof is forwarded verbatim for the admin.
    expect(request.proof).toBe("proof-value-0123456789");
    // `join` carries no name (ADR 0010 §协议增量): the server seeds one from the caps.
    expect(request.name).toMatch(/^iPhone · [A-Z2-7]{4}$/);
    expect("error" in request).toBe(false);
    // A pending request is not a member yet: no `members` broadcast before approval.
    await expectNoMessage(admin, "members");
  });

  it("approves a member with join_ok carrying the full member list", async () => {
    const { port } = await startServer();
    const { admin, roomId, created } = await createRoom(port);
    const member = await connect(port);
    const request = await requestJoin(admin, member, roomId);

    admin.send({ v: 2, type: "approve", memberId: request.memberId });
    const joinOk = await member.next("join_ok");
    expect(joinOk.roomId).toBe(roomId);
    expect(joinOk.selfId).toBe(request.memberId);
    expect(joinOk.name).toBe(request.name);
    expect(joinOk.rejoinToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(joinOk.members).toHaveLength(2);
    expect(memberNamed(joinOk.members, created.selfId).isAdmin).toBe(true);
    expect(memberNamed(joinOk.members, request.memberId)).toMatchObject({
      name: request.name,
      caps: MEMBER_CAPS,
      isAdmin: false,
      state: "joined",
    });

    // The admin learns about the member through `members`, not through join_ok (v2).
    const adminView = await admin.next("members");
    expect(memberNamed(adminView.members, request.memberId).state).toBe(
      "joined",
    );
    await expectNoMessage(admin, "join_ok");
  });

  it("rejects a denied member and frees its slot", async () => {
    const { port } = await startServer();
    const { admin, roomId } = await createRoom(port);
    const member = await connect(port);
    const request = await requestJoin(admin, member, roomId);

    admin.send({
      v: 2,
      type: "deny",
      memberId: request.memberId,
      reason: "ROOM_NOT_FOUND",
    });
    const rejected = await member.next("join_rejected");
    expect(rejected.code).toBe("ROOM_NOT_FOUND");
    expect(rejected.reason).toBe("ROOM_NOT_FOUND");

    // The denied member is gone: signaling to it yields PEER_GONE.
    admin.send({
      v: 2,
      type: "signal",
      to: request.memberId,
      payload: { k: "offer", sdp: "v=0" },
    });
    expect((await admin.next("error")).code).toBe("PEER_GONE");

    const late = await connect(port);
    await requestJoin(admin, late, roomId);
  });

  it("passes free-form deny reasons through as reason text", async () => {
    const { port } = await startServer();
    const { admin, roomId } = await createRoom(port);
    const member = await connect(port);
    const request = await requestJoin(admin, member, roomId);
    admin.send({
      v: 2,
      type: "deny",
      memberId: request.memberId,
      reason: "not right now",
    });
    const rejected = await member.next("join_rejected");
    expect(rejected.code).toBe("ROOM_CLOSED");
    expect(rejected.reason).toBe("not right now");
  });

  it("answers ROOM_NOT_FOUND for an unknown room", async () => {
    const { port } = await startServer();
    const member = await connect(port);
    member.send({
      v: 2,
      type: "join",
      roomId: createRoomIdentity().roomId,
      caps: MEMBER_CAPS,
      nonce: "member-nonce-0123456789",
    });
    expect((await member.next("error")).code).toBe("ROOM_NOT_FOUND");
  });

  it("answers ROOM_FULL once maxGuests is reached", async () => {
    const { port } = await startServer({ maxGuests: 1 });
    const { admin, roomId } = await createRoom(port);
    const first = await connect(port);
    const request = await requestJoin(admin, first, roomId);

    const second = await connect(port);
    second.send({
      v: 2,
      type: "join",
      roomId,
      caps: MEMBER_CAPS,
      nonce: "member-nonce-0123456789",
    });
    expect((await second.next("error")).code).toBe("ROOM_FULL");

    // Denying the pending slot lets someone else in.
    admin.send({ v: 2, type: "deny", memberId: request.memberId });
    await first.next("join_rejected");
    const third = await connect(port);
    await requestJoin(admin, third, roomId);
  });

  it("de-duplicates display names in join order and renumbers after removal", async () => {
    const { port } = await startServer();
    const { admin, roomId, created } = await createRoom(port, { name: "同名" });

    const first = await connect(port);
    const firstRequest = await requestJoin(admin, first, roomId);
    await approve(admin, first, firstRequest);
    first.send({ v: 2, type: "profile", name: "同名" });
    const firstView = await admin.next("members");
    expect(memberNamed(firstView.members, firstRequest.memberId).name).toBe(
      "同名-2",
    );

    const second = await connect(port);
    const secondRequest = await requestJoin(admin, second, roomId);
    await approve(admin, second, secondRequest);
    second.send({ v: 2, type: "profile", name: "同名" });
    const secondView = await admin.next("members");
    expect(memberNamed(secondView.members, secondRequest.memberId).name).toBe(
      "同名-3",
    );

    // The admin keeps the base name and stays first in the list.
    expect(memberNamed(secondView.members, created.selfId).name).toBe("同名");
    expect(secondView.members[0]!.isAdmin).toBe(true);

    admin.send({ v: 2, type: "remove", memberId: firstRequest.memberId });
    const afterRemoval = await admin.next("members");
    expect(
      afterRemoval.members.some((entry) => entry.id === firstRequest.memberId),
    ).toBe(false);
    expect(memberNamed(afterRemoval.members, secondRequest.memberId).name).toBe(
      "同名-2",
    );
  });
});

describe("signal (docs/02 §3.2, §3.6)", () => {
  it("relays offer/answer both ways and strips non-whitelisted payload fields", async () => {
    const { port } = await startServer();
    const { admin, member, request, created } = await joinedPair(port);

    admin.send({
      v: 2,
      type: "signal",
      to: request.memberId,
      payload: { k: "offer", sdp: "v=0", junk: "must not be relayed" },
    });
    const offer = await member.next("signal");
    expect(offer.from).toBe(created.selfId);
    expect(offer.payload).toEqual({ k: "offer", sdp: "v=0" });

    // No "host" sentinel anymore: members address the admin by its member id.
    member.send({
      v: 2,
      type: "signal",
      to: created.selfId,
      payload: { k: "answer", sdp: "v=0\r\n" },
    });
    const answer = await admin.next("signal");
    expect(answer.from).toBe(request.memberId);
    expect(answer.payload).toEqual({ k: "answer", sdp: "v=0\r\n" });

    member.send({
      v: 2,
      type: "signal",
      to: created.selfId,
      payload: {
        k: "candidate",
        candidate: {
          candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host",
          sdpMid: "0",
        },
      },
    });
    const candidate = await admin.next("signal");
    expect(candidate.payload).toEqual({
      k: "candidate",
      candidate: {
        candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host",
        sdpMid: "0",
      },
    });
  });

  it("routes between any two joined members (not only admin↔member)", async () => {
    const { port } = await startServer();
    const { admin, roomId, created } = await createRoom(port);
    const first = await connect(port);
    const firstRequest = await requestJoin(admin, first, roomId);
    await approve(admin, first, firstRequest);
    const second = await connect(port);
    const secondRequest = await requestJoin(admin, second, roomId);
    await approve(admin, second, secondRequest);

    first.send({
      v: 2,
      type: "signal",
      to: secondRequest.memberId,
      payload: { k: "offer", sdp: "v=0 member-to-member" },
    });
    const relayed = await second.next("signal");
    expect(relayed.from).toBe(firstRequest.memberId);
    expect(relayed.payload).toEqual({
      k: "offer",
      sdp: "v=0 member-to-member",
    });

    second.send({
      v: 2,
      type: "signal",
      to: created.selfId,
      payload: { k: "answer", sdp: "v=0 to-admin" },
    });
    expect((await admin.next("signal")).from).toBe(secondRequest.memberId);
  });

  it("answers PEER_GONE for unknown or offline targets", async () => {
    const { port } = await startServer();
    const { admin } = await joinedPair(port);

    admin.send({
      v: 2,
      type: "signal",
      to: "no-such-member",
      payload: { k: "offer", sdp: "v=0" },
    });
    expect((await admin.next("error")).code).toBe("PEER_GONE");
  });

  it("does not relay signal before the member is approved", async () => {
    const { port } = await startServer();
    const { admin, roomId, created } = await createRoom(port);
    const member = await connect(port);
    const request = await requestJoin(admin, member, roomId);
    member.send({
      v: 2,
      type: "signal",
      to: created.selfId,
      payload: { k: "answer", sdp: "v=0" },
    });
    expect((await member.next("error")).code).toBe("PEER_GONE");
    // The admin can still approve afterwards.
    await approve(admin, member, request);
  });
});

describe("rejoinToken (docs/02 §6.6, ADR 0010)", () => {
  it("re-attaches a member inside the window without a new approval", async () => {
    const { port } = await startServer();
    const { admin, member, roomId, request, joinOk } = await joinedPair(port);

    await member.close();
    const offlineView = await admin.next("members");
    expect(memberNamed(offlineView.members, request.memberId).state).toBe(
      "offline",
    );
    await expectNoMessage(admin, "member_left");

    const { client: back, joinOk: again } = await rejoin(
      port,
      roomId,
      joinOk.rejoinToken,
    );
    expect(again.selfId).toBe(request.memberId);
    expect(again.name).toBe(joinOk.name);
    const backView = await admin.next("members");
    expect(memberNamed(backView.members, request.memberId).state).toBe(
      "joined",
    );

    admin.send({
      v: 2,
      type: "signal",
      to: request.memberId,
      payload: { k: "offer", sdp: "v=0 after-rejoin" },
    });
    expect((await back.next("signal")).payload).toEqual({
      k: "offer",
      sdp: "v=0 after-rejoin",
    });
  });

  it("lets the admin re-attach with its rejoinToken through join", async () => {
    const { port } = await startServer();
    const { admin, roomId, created } = await createRoom(port);
    const member = await connect(port);
    const request = await requestJoin(admin, member, roomId);
    await admin.close();

    const admin2 = await connect(port);
    admin2.send({
      v: 2,
      type: "join",
      roomId,
      caps: ADMIN_CAPS,
      nonce: "admin-rejoin-nonce-0123456789",
      rejoinToken: created.rejoinToken,
    });
    const joinOk = await admin2.next("join_ok");
    expect(joinOk.selfId).toBe(created.selfId);
    expect(joinOk.name).toBe(created.name);
    expect(memberNamed(joinOk.members, created.selfId).isAdmin).toBe(true);

    // A re-attached admin is replayed the join requests it still has to decide on.
    const replay = await admin2.next("join_request");
    expect(replay.memberId).toBe(request.memberId);
    admin2.send({ v: 2, type: "approve", memberId: request.memberId });
    expect((await member.next("join_ok")).selfId).toBe(request.memberId);
  });

  it("rejects an unknown rejoin token", async () => {
    const { port } = await startServer();
    const { roomId } = await createRoom(port);
    const stale = await connect(port);
    stale.send({
      v: 2,
      type: "join",
      roomId,
      caps: MEMBER_CAPS,
      nonce: "member-nonce-0123456789",
      rejoinToken: "not-a-real-token",
    });
    expect((await stale.next("error")).code).toBe("ROOM_NOT_FOUND");
  });

  it("removes an offline member after the reconnect window and tells the admin", async () => {
    const { port } = await startServer({ reconnectWindowMs: 120 });
    const { admin, member, roomId, request } = await joinedPair(port);

    await member.close();
    const offlineView = await admin.next("members");
    expect(memberNamed(offlineView.members, request.memberId).state).toBe(
      "offline",
    );

    const left = await admin.next("member_left", 2_000);
    expect(left.memberId).toBe(request.memberId);
    const afterExpiry = await admin.next("members");
    expect(
      afterExpiry.members.some((entry) => entry.id === request.memberId),
    ).toBe(false);

    // The freed slot accepts a new join request.
    const late = await connect(port);
    const lateRequest = await requestJoin(admin, late, roomId);
    expect(lateRequest.memberId).not.toBe(request.memberId);
  });
});

describe("profile (ADR 0010 §names)", () => {
  it("broadcasts a rename to every member, admin included", async () => {
    const { port } = await startServer();
    const { admin, member, request } = await joinedPair(port);

    member.send({ v: 2, type: "profile", name: "客厅的电脑" });
    const adminView = await admin.next("members");
    const memberView = await member.next("members");
    expect(memberNamed(adminView.members, request.memberId).name).toBe(
      "客厅的电脑",
    );
    expect(memberNamed(memberView.members, request.memberId).name).toBe(
      "客厅的电脑",
    );

    admin.send({ v: 2, type: "profile", name: "书房电脑" });
    const renamed = await member.next("members");
    expect(renamed.members[0]!.isAdmin).toBe(true);
    expect(renamed.members[0]!.name).toBe("书房电脑");
  });

  it("rejects an invalid name with BAD_MESSAGE", async () => {
    const { port } = await startServer();
    const { member } = await joinedPair(port);
    member.send({ v: 2, type: "profile", name: "   " });
    expect((await member.next("error")).code).toBe("BAD_MESSAGE");
  });

  it("rate limits profile updates per connection", async () => {
    const { port } = await startServer();
    const { member } = await joinedPair(port);
    for (let index = 0; index < 10; index += 1) {
      member.send({ v: 2, type: "profile", name: `名称${index}` });
      await sleep(2);
    }
    member.send({ v: 2, type: "profile", name: "太快了" });
    expect((await member.next("error")).code).toBe("RATE_LIMITED");
  });

  it("refuses a rename before the member is approved", async () => {
    const { port } = await startServer();
    const { admin, roomId } = await createRoom(port);
    const member = await connect(port);
    await requestJoin(admin, member, roomId);
    member.send({ v: 2, type: "profile", name: "太早了" });
    expect((await member.next("error")).code).toBe("PEER_GONE");
  });
});

describe("remove / close (docs/02 §3.2, docs/01 AC7)", () => {
  it("removes a joined member on admin request", async () => {
    const { port } = await startServer();
    const { admin, member, roomId, request } = await joinedPair(port);

    admin.send({ v: 2, type: "remove", memberId: request.memberId });
    const closed = await member.next("room_closed");
    expect(closed.reason).toBe("error");
    expect((await member.closed()).code).toBe(1000);

    const left = await admin.next("member_left");
    expect(left.memberId).toBe(request.memberId);
    const view = await admin.next("members");
    expect(view.members.some((entry) => entry.id === request.memberId)).toBe(
      false,
    );

    // The room itself is still alive.
    const nextMember = await connect(port);
    await requestJoin(admin, nextMember, roomId);
  });

  it("answers NOT_ADMIN for admin-only operations sent by a member", async () => {
    const { port } = await startServer();
    const { admin, member, roomId, request, created } = await joinedPair(port);

    member.send({ v: 2, type: "approve", memberId: "someone" });
    expect((await member.next("error")).code).toBe("NOT_ADMIN");
    member.send({ v: 2, type: "deny", memberId: "someone" });
    expect((await member.next("error")).code).toBe("NOT_ADMIN");
    member.send({ v: 2, type: "remove", memberId: "someone" });
    expect((await member.next("error")).code).toBe("NOT_ADMIN");
    member.send({ v: 2, type: "close", roomId });
    expect((await member.next("error")).code).toBe("NOT_ADMIN");

    // The room is untouched.
    member.send({
      v: 2,
      type: "signal",
      to: created.selfId,
      payload: { k: "offer", sdp: "v=0" },
    });
    expect((await admin.next("signal")).from).toBe(request.memberId);
  });

  it("closes the room for every member and destroys it immediately", async () => {
    const { port } = await startServer();
    const { admin, member, roomId } = await joinedPair(port);
    admin.send({ v: 2, type: "close", roomId });
    const closed = await member.next("room_closed");
    expect(closed.reason).toBe("admin_close");
    await member.closed();

    const late = await connect(port);
    late.send({
      v: 2,
      type: "join",
      roomId,
      caps: MEMBER_CAPS,
      nonce: "member-nonce-0123456789",
    });
    expect((await late.next("error")).code).toBe("ROOM_NOT_FOUND");
  });

  it("silently drops a pending join request whose socket goes away", async () => {
    const { port } = await startServer();
    const { admin, roomId } = await createRoom(port);
    const member = await connect(port);
    await requestJoin(admin, member, roomId);
    await member.close();
    await sleep(30);
    // No members broadcast: the pending request never entered the visible list.
    await expectNoMessage(admin, "members");
    const late = await connect(port);
    await requestJoin(admin, late, roomId);
  });
});

describe("six digit code (docs/02 §3.5)", () => {
  it("maps the code to the room and consumes it on the first successful join", async () => {
    const { port } = await startServer();
    const { admin, code } = await createRoom(port);

    const first = await connect(port);
    const request = await requestJoin(admin, first, code, { proof: null });
    expect(request.caps).toEqual(MEMBER_CAPS);
    expect(request.proof).toBeUndefined();
    await approve(admin, first, request);

    const second = await connect(port);
    second.send({
      v: 2,
      type: "join",
      roomId: code,
      caps: MEMBER_CAPS,
      nonce: "member-nonce-0123456789",
    });
    expect((await second.next("error")).code).toBe("ROOM_NOT_FOUND");
  });

  it("expires the code after ten minutes", async () => {
    const { port } = await startServer();
    const { code } = await createRoom(port);
    const issuedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(issuedAt + SHORTCODE_TTL_MS + 1);

    const member = await connect(port);
    member.send({
      v: 2,
      type: "join",
      roomId: code,
      caps: MEMBER_CAPS,
      nonce: "member-nonce-0123456789",
    });
    expect((await member.next("error")).code).toBe("ROOM_NOT_FOUND");
  });
});

describe("heartbeat and TTL (docs/01 D7, docs/02 §3.2)", () => {
  it("expires an idle room, notifies both sides and deletes it from memory", async () => {
    const { port } = await startServer({ roomTtlMs: 100 });
    const { admin, member, roomId } = await joinedPair(port);

    const memberClosed = await member.next("room_closed", 2_000);
    expect(memberClosed.reason).toBe("ttl");
    const adminClosed = await admin.next("room_closed", 2_000);
    expect(adminClosed.reason).toBe("ttl");

    const late = await connect(port);
    late.send({
      v: 2,
      type: "join",
      roomId,
      caps: MEMBER_CAPS,
      nonce: "member-nonce-0123456789",
    });
    expect((await late.next("error")).code).toBe("ROOM_NOT_FOUND");
  });

  it("extends the room lifetime on admin heartbeat", async () => {
    const { port } = await startServer({ roomTtlMs: 150 });
    const { admin, roomId } = await createRoom(port);
    for (let index = 0; index < 5; index += 1) {
      admin.send({ v: 2, type: "heartbeat", roomId });
      await sleep(40);
    }
    // 200 ms elapsed with a 150 ms TTL: the admin heartbeats kept it alive.
    await expectNoMessage(admin, "room_closed", 60);
  });

  it("ignores member heartbeats so a silent admin still expires the room (phase 1)", async () => {
    const { port } = await startServer({ roomTtlMs: 120 });
    const { admin, member, roomId } = await joinedPair(port);
    for (let index = 0; index < 5; index += 1) {
      try {
        member.send({ v: 2, type: "heartbeat", roomId });
      } catch {
        break;
      }
      await sleep(40);
    }
    const adminClosed = await admin.next("room_closed", 2_000);
    expect(adminClosed.reason).toBe("ttl");
    await member.next("room_closed", 2_000);
  });
});

describe("robustness (docs/02 §3.1, §3.7)", () => {
  it("answers BAD_MESSAGE for unknown types and keeps the connection usable", async () => {
    const { port } = await startServer();
    const client = await connect(port);
    client.send({ v: 2, type: "hello" });
    client.send({ v: 2, type: "not-a-message" });
    expect((await client.next("error")).code).toBe("BAD_MESSAGE");

    client.send({ v: 2, type: "hello" });
    await expectNoMessage(client, "error");
  });

  it("closes the connection after repeated malformed frames", async () => {
    const { port } = await startServer();
    const client = await connect(port);
    client.sendText("not json at all");
    for (let index = 0; index < 5; index += 1)
      client.send({ v: 2, type: "broken", index });
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
    const { port } = await startServer({
      rateLimit: { windowMs: 60_000, max: 3 },
    });
    const client = await connect(port);
    for (let index = 0; index < 3; index += 1)
      client.send({ v: 2, type: "hello" });
    client.send({ v: 2, type: "hello" });
    expect((await client.next("error")).code).toBe("RATE_LIMITED");
    expect((await client.closed(2_000)).code).toBe(1008);
  });
});

describe("TURN credentials (docs/02 §6.8)", () => {
  it("issues coturn static-auth credentials per member", async () => {
    const secret = "static-auth-secret-for-tests";
    const uris = [
      "turn:turn.example.org:3478?transport=udp",
      "turns:turn.example.org:5349",
    ];
    const ttl = 600;
    const { port } = await startServer({ turn: { uris, secret, ttl } });
    const { admin, roomId, created } = await createRoom(port);

    expect(created.turn).toBeDefined();
    const credential = created.turn!;
    expect(credential.uris).toEqual(uris);
    expect(credential.ttl).toBe(ttl);
    const match = /^(\d+):([A-Za-z0-9_-]{11})$/.exec(credential.username);
    expect(match).not.toBeNull();
    const expiry = Number(match![1]);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    expect(Math.abs(expiry - (nowSeconds + ttl))).toBeLessThanOrEqual(2);
    expect(credential.username.split(":")[1]).toBe(created.selfId);
    const expected = createHmac("sha1", secret)
      .update(credential.username)
      .digest("base64");
    expect(credential.credential).toBe(expected);

    // join_ok carries a credential for the approved member.
    const member = await connect(port);
    const request = await requestJoin(admin, member, roomId);
    const { joinOk } = await approve(admin, member, request);
    expect(joinOk.turn).toBeDefined();
    expect(joinOk.turn!.username.split(":")[1]).toBe(request.memberId);
    expect(joinOk.turn!.credential).toBe(
      createHmac("sha1", secret).update(joinOk.turn!.username).digest("base64"),
    );
  });
});
