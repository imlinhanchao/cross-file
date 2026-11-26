import { describe, expect, it } from "vitest";
import { randomBytes, utf8, bytesToHex } from "./bytes.js";
import {
  EMOJI_64,
  IncrementalSha256,
  computeJoinProof,
  computeSas,
  deriveFileKey,
  deriveSessionKey,
  importFileKey,
  openChunk,
  parseDtlsFingerprint,
  sealChunk,
  sha256Hex,
  verifyJoinProof,
} from "./crypto.js";
import { createRoomIdentity } from "./ids.js";

const roomIdBytes = new Uint8Array(16).fill(7);
const roomKey = new Uint8Array(32).fill(9);

describe("key derivation", () => {
  it("is deterministic for the same inputs", () => {
    expect(bytesToHex(deriveSessionKey(roomKey, roomIdBytes))).toBe(
      bytesToHex(deriveSessionKey(roomKey, roomIdBytes)),
    );
  });

  it("changes when the room changes", () => {
    const other = new Uint8Array(16).fill(8);
    expect(bytesToHex(deriveSessionKey(roomKey, other))).not.toBe(
      bytesToHex(deriveSessionKey(roomKey, roomIdBytes)),
    );
  });

  it("derives a distinct key per file", () => {
    const session = deriveSessionKey(roomKey, roomIdBytes);
    expect(bytesToHex(deriveFileKey(session, "t1", 1))).not.toBe(
      bytesToHex(deriveFileKey(session, "t1", 2)),
    );
  });

  it("derives a distinct key per transfer (both directions of a pair)", () => {
    const session = deriveSessionKey(roomKey, roomIdBytes);
    expect(bytesToHex(deriveFileKey(session, "t1", 1))).not.toBe(
      bytesToHex(deriveFileKey(session, "t2", 1)),
    );
  });

  it("is deterministic for the same transfer and file", () => {
    const session = deriveSessionKey(roomKey, roomIdBytes);
    expect(bytesToHex(deriveFileKey(session, "alpha:1", 7))).toBe(
      bytesToHex(deriveFileKey(session, "alpha:1", 7)),
    );
  });
});

describe("chunk AEAD", () => {
  const salt = new Uint8Array([1, 2, 3, 4]);

  async function keyFor(fileId: number): Promise<CryptoKey> {
    return importFileKey(
      deriveFileKey(deriveSessionKey(roomKey, roomIdBytes), "t1", fileId),
    );
  }

  it("round-trips a chunk", async () => {
    const key = await keyFor(1);
    const plaintext = utf8("hello crossfile");
    const ciphertext = await sealChunk({
      key,
      fileId: 1,
      seq: 0,
      salt,
      plaintext,
    });
    expect(ciphertext.length).toBe(plaintext.length + 16);
    const opened = await openChunk({
      key,
      fileId: 1,
      seq: 0,
      salt,
      ciphertext,
    });
    expect(bytesToHex(opened)).toBe(bytesToHex(plaintext));
  });

  it("produces distinct ciphertexts for distinct sequence numbers (unique nonce)", async () => {
    const key = await keyFor(1);
    const plaintext = utf8("same plaintext, different seq");
    const a = await sealChunk({ key, fileId: 1, seq: 0, salt, plaintext });
    const b = await sealChunk({ key, fileId: 1, seq: 1, salt, plaintext });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("rejects tampered ciphertext", async () => {
    const key = await keyFor(1);
    const ciphertext = await sealChunk({
      key,
      fileId: 1,
      seq: 3,
      salt,
      plaintext: utf8("payload"),
    });
    ciphertext[0]! ^= 0xff;
    await expect(
      openChunk({ key, fileId: 1, seq: 3, salt, ciphertext }),
    ).rejects.toThrow();
  });

  it("rejects a replayed chunk under another sequence number (aad binds seq)", async () => {
    const key = await keyFor(1);
    const ciphertext = await sealChunk({
      key,
      fileId: 1,
      seq: 5,
      salt,
      plaintext: utf8("payload"),
    });
    await expect(
      openChunk({ key, fileId: 1, seq: 6, salt, ciphertext }),
    ).rejects.toThrow();
  });

  it("rejects a chunk moved to another file (aad binds fileId)", async () => {
    const key = await keyFor(1);
    const ciphertext = await sealChunk({
      key,
      fileId: 1,
      seq: 0,
      salt,
      plaintext: utf8("payload"),
    });
    await expect(
      openChunk({ key, fileId: 2, seq: 0, salt, ciphertext }),
    ).rejects.toThrow();
  });
});

describe("join proof", () => {
  const room = createRoomIdentity();
  const guestNonce = "abcdefgh12345678";

  it("accepts the host-computed proof", () => {
    const proof = computeJoinProof(room.roomKey, room.roomIdBytes, guestNonce);
    expect(
      verifyJoinProof(room.roomKey, room.roomIdBytes, guestNonce, proof),
    ).toBe(true);
  });

  it("rejects a proof made with another room key (fake guest injection)", () => {
    const attackerKey = randomBytes(32);
    const proof = computeJoinProof(attackerKey, room.roomIdBytes, guestNonce);
    expect(
      verifyJoinProof(room.roomKey, room.roomIdBytes, guestNonce, proof),
    ).toBe(false);
  });

  it("rejects a proof bound to another nonce", () => {
    const proof = computeJoinProof(room.roomKey, room.roomIdBytes, guestNonce);
    expect(
      verifyJoinProof(room.roomKey, room.roomIdBytes, "other-nonce", proof),
    ).toBe(false);
  });

  it("rejects missing or garbage proofs", () => {
    expect(
      verifyJoinProof(room.roomKey, room.roomIdBytes, guestNonce, undefined),
    ).toBe(false);
    expect(
      verifyJoinProof(
        room.roomKey,
        room.roomIdBytes,
        guestNonce,
        "**not base64**",
      ),
    ).toBe(false);
  });
});

describe("SAS", () => {
  const fpA =
    "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
  const fpB =
    "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";

  it("is symmetric: both sides show the same four emoji", () => {
    expect(computeSas(fpA, fpB)).toEqual(computeSas(fpB, fpA));
  });

  it("shows four emoji drawn from the 64 emoji table", () => {
    const sas = computeSas(fpA, fpB);
    expect(sas).toHaveLength(4);
    for (const emoji of sas) expect(EMOJI_64).toContain(emoji);
  });

  it("changes when either fingerprint is replaced (MITM detection)", () => {
    expect(computeSas(fpA, fpB)).not.toEqual(
      computeSas(fpA, fpB.replace("11:", "12:")),
    );
  });

  it("reads the fingerprint out of SDP", () => {
    const sdp = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${fpA}\r\n`;
    expect(parseDtlsFingerprint(sdp)).toBe(fpA);
  });
});

describe("incremental sha256", () => {
  it("matches a one-shot digest for split input", () => {
    const data = randomBytes(1024 * 1024 + 37);
    const hasher = new IncrementalSha256();
    let offset = 0;
    for (const step of [1, 15, 4096, 65536, 100_000]) {
      if (offset >= data.length) break;
      hasher.update(data.subarray(offset, offset + step));
      offset += step;
    }
    hasher.update(data.subarray(offset));
    expect(hasher.digestHex()).toBe(sha256Hex(data));
  });
});
