import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_CIPHERTEXT,
  FRAME_MAX_BYTES,
  chunkCountFor,
  decodeChunkFrame,
  encodeChunkFrame,
  parseClientMessage,
  parseCtrlMessage,
} from "./protocol.js";
import { randomBytes } from "./bytes.js";

describe("chunk frame codec", () => {
  it("round-trips fileId/seq/last/ciphertext", () => {
    const ciphertext = randomBytes(1024);
    const frame = encodeChunkFrame({ fileId: 3, seq: 42, last: true, ciphertext });
    const decoded = decodeChunkFrame(frame);
    expect(decoded.fileId).toBe(3);
    expect(decoded.seq).toBe(42);
    expect(decoded.last).toBe(true);
    expect(Array.from(decoded.ciphertext)).toEqual(Array.from(ciphertext));
  });

  it("has the documented 12 byte header", () => {
    const frame = encodeChunkFrame({ fileId: 1, seq: 0, last: false, ciphertext: randomBytes(16) });
    expect(frame.length).toBe(12 + 16);
    expect(frame[0]).toBe(1);
  });

  it("rejects an oversized frame", () => {
    expect(() =>
      encodeChunkFrame({ fileId: 1, seq: 0, last: false, ciphertext: new Uint8Array(CHUNK_MAX_CIPHERTEXT + 1) }),
    ).toThrow();
  });

  it("rejects truncated or corrupted frames", () => {
    const frame = encodeChunkFrame({ fileId: 1, seq: 0, last: false, ciphertext: randomBytes(64) });
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

describe("signaling message validation", () => {
  it("accepts a well-formed create", () => {
    const message = parseClientMessage({
      v: 1,
      type: "create",
      roomId: "a".repeat(26),
      hostCaps: capsStub(),
    });
    expect(message.type).toBe("create");
  });

  it("rejects a non base32 roomId", () => {
    expect(() =>
      parseClientMessage({ v: 1, type: "create", roomId: "not-a-room-id", hostCaps: capsStub() }),
    ).toThrow();
  });

  it("rejects unknown message types", () => {
    expect(() => parseClientMessage({ v: 1, type: "exfiltrate" })).toThrow();
  });

  it("rejects signals with unexpected fields", () => {
    expect(() =>
      parseClientMessage({ v: 1, type: "signal", to: "x", payload: { k: "offer", sdp: "", extra: 1 } }),
    ).toThrow();
  });
});

describe("control message validation", () => {
  it("accepts a manifest", () => {
    const message = parseCtrlMessage({
      v: 1,
      type: "manifest",
      files: [{ id: 1, name: "a.mp4", size: 1000, mime: "video/mp4", chunk: 65536, chunkCount: 1, salt: "AAAAAA==" }],
      totalSize: 1000,
      chunkNegotiation: { min: 65536, max: 262144 },
    });
    expect(message.type).toBe("manifest");
  });

  it("rejects a manifest with a chunk size outside the negotiated bounds", () => {
    expect(() =>
      parseCtrlMessage({
        v: 1,
        type: "manifest",
        files: [{ id: 1, name: "a", size: 1, mime: "", chunk: 1024, chunkCount: 1, salt: "AAAAAA==" }],
        totalSize: 1,
        chunkNegotiation: { min: 65536, max: 262144 },
      }),
    ).toThrow();
  });

  it("accepts error codes from the documented set only", () => {
    expect(parseCtrlMessage({ v: 1, type: "error", code: "HASH_MISMATCH", msg: "x" }).type).toBe("error");
    expect(() => parseCtrlMessage({ v: 1, type: "error", code: "WHATEVER", msg: "x" })).toThrow();
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
