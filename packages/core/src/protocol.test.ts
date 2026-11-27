import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_CIPHERTEXT,
  FRAME_MAX_BYTES,
  MAX_GUESTS,
  MAX_MEMBERS,
  PROTOCOL_VERSION,
  VersionMismatchError,
  chunkCountFor,
  decodeChunkFrame,
  encodeChunkFrame,
  memberInfoSchema,
  parseClientMessage,
  parseCtrlMessage,
} from "./protocol.js";
import { randomBytes } from "./bytes.js";

describe("chunk frame codec", () => {
  it("round-trips fileId/seq/last/ciphertext", () => {
    const ciphertext = randomBytes(1024);
    const frame = encodeChunkFrame({
      fileId: 3,
      seq: 42,
      last: true,
      ciphertext,
    });
    const decoded = decodeChunkFrame(frame);
    expect(decoded.fileId).toBe(3);
    expect(decoded.seq).toBe(42);
    expect(decoded.last).toBe(true);
    expect(Array.from(decoded.ciphertext)).toEqual(Array.from(ciphertext));
  });

  it("has the documented 12 byte header", () => {
    const frame = encodeChunkFrame({
      fileId: 1,
      seq: 0,
      last: false,
      ciphertext: randomBytes(16),
    });
    expect(frame.length).toBe(12 + 16);
    expect(frame[0]).toBe(1);
  });

  it("rejects an oversized frame", () => {
    expect(() =>
      encodeChunkFrame({
        fileId: 1,
        seq: 0,
        last: false,
        ciphertext: new Uint8Array(CHUNK_MAX_CIPHERTEXT + 1),
      }),
    ).toThrow();
  });

  it("rejects truncated or corrupted frames", () => {
    const frame = encodeChunkFrame({
      fileId: 1,
      seq: 0,
      last: false,
      ciphertext: randomBytes(64),
    });
    expect(() => decodeChunkFrame(frame.subarray(0, 10))).toThrow();
    const bad = frame.slice();
    bad[7] = (bad[7]! ^ 0x01) & 0xff; // declared length no longer matches payload
    expect(() => decodeChunkFrame(bad)).toThrow();
  });

  it("never emits a frame larger than the SCTP message limit", () => {
    const frame = encodeChunkFrame({
      fileId: 65535,
      seq: 0xffffffff,
      last: true,
      ciphertext: new Uint8Array(CHUNK_MAX_CIPHERTEXT),
    });
    expect(frame.length).toBeLessThanOrEqual(FRAME_MAX_BYTES);
  });
});

describe("chunk counting", () => {
  it("ceil-divides sizes", () => {
    expect(chunkCountFor(0, 65536)).toBe(1);
    expect(chunkCountFor(1, 65536)).toBe(1);
    expect(chunkCountFor(65536, 65536)).toBe(1);
    expect(chunkCountFor(65537, 65536)).toBe(2);
    expect(chunkCountFor(500 * 1024 * 1024, 65536)).toBe(8000);
  });
});

describe("protocol constants", () => {
  it("is protocol v2", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("keeps the room capacity at 4 and the v1 alias in sync", () => {
    expect(MAX_MEMBERS).toBe(4);
    expect(MAX_GUESTS).toBe(MAX_MEMBERS);
  });
});

describe("signaling message validation (v2)", () => {
  it("accepts a well-formed create with caps and a display name", () => {
    const message = parseClientMessage({
      v: 2,
      type: "create",
      roomId: "a".repeat(26),
      caps: capsStub(),
      name: "MacBook · 7K2F",
    });
    expect(message.type).toBe("create");
  });

  it("rejects a create without a display name", () => {
    expect(() =>
      parseClientMessage({
        v: 2,
        type: "create",
        roomId: "a".repeat(26),
        caps: capsStub(),
      }),
    ).toThrow();
  });

  it("keeps the optional phase-2 caps.mesh flag, and omits it when absent", () => {
    const withMesh = parseClientMessage({
      v: 2,
      type: "create",
      roomId: "a".repeat(26),
      caps: { ...capsStub(), mesh: true },
      name: "MacBook · 7K2F",
    });
    if (withMesh.type !== "create") throw new Error("expected create");
    expect(withMesh.caps.mesh).toBe(true);

    const withoutMesh = parseClientMessage({
      v: 2,
      type: "create",
      roomId: "a".repeat(26),
      caps: capsStub(),
      name: "MacBook · 7K2F",
    });
    if (withoutMesh.type !== "create") throw new Error("expected create");
    // A phase-1 client must stay indistinguishable from before (no `mesh: false`).
    expect("mesh" in withoutMesh.caps).toBe(false);
  });

  it("accepts a join with proof and rejoin token", () => {
    const message = parseClientMessage({
      v: 2,
      type: "join",
      roomId: "a".repeat(26),
      caps: capsStub(),
      nonce: "abcdefgh12345678",
      proof: "proof-value",
      rejoinToken: "token-value",
    });
    expect(message.type).toBe("join");
  });

  it("rejects a join without a nonce", () => {
    expect(() =>
      parseClientMessage({
        v: 2,
        type: "join",
        roomId: "a".repeat(26),
        caps: capsStub(),
      }),
    ).toThrow();
  });

  it("addresses members by memberId on approve/deny/remove", () => {
    for (const message of [
      { v: 2, type: "approve", memberId: "peer-1" },
      { v: 2, type: "deny", memberId: "peer-1", reason: "nope" },
      { v: 2, type: "remove", memberId: "peer-1" },
    ]) {
      expect(parseClientMessage(message).type).toBe(message.type);
    }
  });

  it("rejects the v1 guestId field", () => {
    expect(() =>
      parseClientMessage({ v: 2, type: "approve", guestId: "guest-1" }),
    ).toThrow();
  });

  it("accepts a profile rename and arbitrary peer addressing", () => {
    expect(
      parseClientMessage({ v: 2, type: "profile", name: "客厅的电脑" }).type,
    ).toBe("profile");
    expect(
      parseClientMessage({
        v: 2,
        type: "signal",
        to: "peer-2",
        payload: { k: "offer", sdp: "v=0" },
      }).type,
    ).toBe("signal");
  });

  it("accepts hello/heartbeat/close", () => {
    expect(parseClientMessage({ v: 2, type: "hello" }).type).toBe("hello");
    expect(
      parseClientMessage({ v: 2, type: "heartbeat", roomId: "room" }).type,
    ).toBe("heartbeat");
    expect(
      parseClientMessage({ v: 2, type: "close", roomId: "room" }).type,
    ).toBe("close");
  });

  it("rejects unknown message types", () => {
    expect(() => parseClientMessage({ v: 2, type: "exfiltrate" })).toThrow();
  });

  it("rejects a non base32 roomId", () => {
    expect(() =>
      parseClientMessage({
        v: 2,
        type: "create",
        roomId: "not-a-room-id",
        caps: capsStub(),
        name: "设备",
      }),
    ).toThrow();
  });

  it("rejects signals with unexpected fields", () => {
    expect(() =>
      parseClientMessage({
        v: 2,
        type: "signal",
        to: "x",
        payload: { k: "offer", sdp: "", extra: 1 },
      }),
    ).toThrow();
  });

  it("rejects v1 clients with VersionMismatchError (no compatibility layer)", () => {
    expect(() =>
      parseClientMessage({
        v: 1,
        type: "create",
        roomId: "a".repeat(26),
        caps: capsStub(),
        name: "old",
      }),
    ).toThrow(VersionMismatchError);
    try {
      parseClientMessage({ v: 1, type: "hello" });
    } catch (error) {
      expect((error as VersionMismatchError).received).toBe(1);
    }
  });
});

describe("member info", () => {
  it("accepts a joined and an offline member", () => {
    const joined = memberInfoSchema.parse({
      id: "peer-1",
      name: "MacBook · 7K2F",
      caps: capsStub(),
      isAdmin: true,
      state: "joined",
    });
    const offline = memberInfoSchema.parse({
      ...joined,
      isAdmin: false,
      state: "offline",
    });
    expect(joined.state).toBe("joined");
    expect(offline.state).toBe("offline");
  });

  it("rejects unknown member states", () => {
    expect(() =>
      memberInfoSchema.parse({
        id: "peer-1",
        name: "设备",
        caps: capsStub(),
        isAdmin: false,
        state: "banned",
      }),
    ).toThrow();
  });
});

describe("control message validation (v2)", () => {
  it("accepts a hello carrying caps", () => {
    expect(
      parseCtrlMessage({ v: 2, type: "hello", caps: capsStub() }).type,
    ).toBe("hello");
  });

  it("accepts a manifest with a transfer id", () => {
    const message = parseCtrlMessage({
      v: 2,
      type: "manifest",
      transferId: "peer-1:1",
      files: [
        {
          id: 1,
          name: "a.mp4",
          size: 1000,
          mime: "video/mp4",
          chunk: 65536,
          chunkCount: 1,
          salt: "AAAAAA==",
        },
      ],
      totalSize: 1000,
      chunkNegotiation: { min: 65536, max: 262144 },
    });
    expect(message.type).toBe("manifest");
  });

  it("rejects a manifest without a transfer id", () => {
    expect(() =>
      parseCtrlMessage({
        v: 2,
        type: "manifest",
        files: [
          {
            id: 1,
            name: "a",
            size: 1,
            mime: "",
            chunk: 65536,
            chunkCount: 1,
            salt: "AAAAAA==",
          },
        ],
        totalSize: 1,
        chunkNegotiation: { min: 65536, max: 262144 },
      }),
    ).toThrow();
  });

  it("rejects a manifest with a chunk size outside the negotiated bounds", () => {
    expect(() =>
      parseCtrlMessage({
        v: 2,
        type: "manifest",
        transferId: "t1",
        files: [
          {
            id: 1,
            name: "a",
            size: 1,
            mime: "",
            chunk: 1024,
            chunkCount: 1,
            salt: "AAAAAA==",
          },
        ],
        totalSize: 1,
        chunkNegotiation: { min: 65536, max: 262144 },
      }),
    ).toThrow();
  });

  it("requires a transfer id on every transfer-scoped message", () => {
    const scoped = [
      { v: 2, type: "accept", fileIds: [1] },
      { v: 2, type: "bitmap", fileId: 1, bits: "AA==" },
      { v: 2, type: "progress", fileId: 1, seq: 0 },
      { v: 2, type: "done", fileId: 1, sha256: "a".repeat(64), chunkCount: 1 },
      { v: 2, type: "ack", fileId: 1, ok: true },
      { v: 2, type: "pause" },
      { v: 2, type: "resume" },
      { v: 2, type: "cancel" },
    ];
    for (const message of scoped) {
      expect(() => parseCtrlMessage(message)).toThrow();
      expect(parseCtrlMessage({ ...message, transferId: "t1" }).type).toBe(
        message.type,
      );
    }
  });

  it("parses the cancel message with an optional reason", () => {
    expect(
      parseCtrlMessage({ v: 2, type: "cancel", transferId: "me:3" }),
    ).toEqual({ v: 2, type: "cancel", transferId: "me:3" });
    expect(
      parseCtrlMessage({
        v: 2,
        type: "cancel",
        transferId: "me:3",
        reason: "user",
      }),
    ).toEqual({ v: 2, type: "cancel", transferId: "me:3", reason: "user" });
    expect(() =>
      parseCtrlMessage({ v: 2, type: "cancel", transferId: "me:3", reason: 1 }),
    ).toThrow();
  });

  it("parses channel-level ping/pong without a transfer id", () => {
    expect(parseCtrlMessage({ v: 2, type: "ping" })).toEqual({
      v: 2,
      type: "ping",
    });
    expect(parseCtrlMessage({ v: 2, type: "pong" })).toEqual({
      v: 2,
      type: "pong",
    });
    // Channel-level: no transfer scope is required, and a stray one is stripped
    // by the zod object shape (it never reaches the handler).
    expect(
      parseCtrlMessage({ v: 2, type: "ping", transferId: "me:1" }),
    ).toEqual({ v: 2, type: "ping" });
  });

  it("throws on an unknown ctrl type so old pages can drop newer frames", () => {
    // peer.ts catches this and silently ignores the frame: that is the
    // compatibility contract for messages added after a page was built.
    expect(() => parseCtrlMessage({ v: 2, type: "future-thing" })).toThrow();
    expect(() => parseCtrlMessage({ v: 1, type: "ping" })).toThrow();
  });

  it("accepts an error with or without a transfer id", () => {
    expect(
      parseCtrlMessage({ v: 2, type: "error", code: "HASH_MISMATCH", msg: "x" })
        .type,
    ).toBe("error");
    expect(
      parseCtrlMessage({
        v: 2,
        type: "error",
        transferId: "t1",
        code: "PEER_GONE",
        msg: "x",
        fileId: 2,
      }).type,
    ).toBe("error");
  });

  it("accepts the documented error codes only, including the v2 additions", () => {
    for (const code of ["VERSION_MISMATCH", "NOT_ADMIN"]) {
      expect(
        parseCtrlMessage({ v: 2, type: "error", code, msg: "x" }).type,
      ).toBe("error");
    }
    expect(() =>
      parseCtrlMessage({ v: 2, type: "error", code: "WHATEVER", msg: "x" }),
    ).toThrow();
  });

  it("keeps the SAS / room-key handshake unchanged", () => {
    expect(parseCtrlMessage({ v: 2, type: "sas-confirm" }).type).toBe(
      "sas-confirm",
    );
    expect(
      parseCtrlMessage({
        v: 2,
        type: "room-key",
        key: "a2V5",
        roomId: "room",
      }).type,
    ).toBe("room-key");
    expect(parseCtrlMessage({ v: 2, type: "key-ok" }).type).toBe("key-ok");
  });

  it("rejects v1 control messages", () => {
    expect(() =>
      parseCtrlMessage({
        v: 1,
        type: "hello",
        guestCaps: capsStub(),
      }),
    ).toThrow();
  });
});

function capsStub() {
  return {
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
}
