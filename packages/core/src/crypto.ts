/**
 * Crypto primitives (docs/02 §4).
 *
 * Key hierarchy:
 *   roomKey  = 32 random bytes, lives only in the URL fragment / SAS-authenticated channel
 *   sessionKey = HKDF-SHA256(roomKey, salt=roomId, info="crossfile/v1/session", 32)
 *   fileKey    = HKDF-SHA256(sessionKey, info="file:<id>", 32)
 *
 * Chunk AEAD: AES-256-GCM
 *   nonce = fileSalt(4) || chunkSeq(8, big endian)
 *   aad   = fileId(2) || chunkSeq(4) || ciphertextLen(4), all big endian
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import {
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  timingSafeEqual,
  u16be,
  u32be,
  u64be,
  utf8,
  bytesToHex,
} from "./bytes.js";

const SESSION_INFO = "crossfile/v1/session";
const SAS_INFO = "crossfile/v1/sas";
const JOIN_PREFIX = "join:";
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;

export function deriveSessionKey(roomKey: Uint8Array, roomIdBytes: Uint8Array): Uint8Array {
  return hkdf(sha256, roomKey, roomIdBytes, utf8(SESSION_INFO), KEY_BYTES);
}

export function deriveFileKey(sessionKey: Uint8Array, fileId: number): Uint8Array {
  return hkdf(sha256, sessionKey, new Uint8Array(0), utf8(`file:${fileId}`), KEY_BYTES);
}

export async function importFileKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function buildNonce(salt: Uint8Array, seq: number): Uint8Array {
  if (salt.length !== 4) throw new Error("file salt must be 4 bytes");
  return concatBytes(salt, u64be(BigInt(seq)));
}

export function buildAad(fileId: number, seq: number, ciphertextLength: number): Uint8Array {
  return concatBytes(u16be(fileId), u32be(seq), u32be(ciphertextLength));
}

export interface SealOptions {
  key: CryptoKey;
  fileId: number;
  seq: number;
  salt: Uint8Array;
  plaintext: Uint8Array;
}

export async function sealChunk({ key, fileId, seq, salt, plaintext }: SealOptions): Promise<Uint8Array> {
  const ciphertextLength = plaintext.length + TAG_BYTES;
  const nonce = buildNonce(salt, seq);
  if (nonce.length !== NONCE_BYTES) throw new Error("bad nonce length");
  const aad = buildAad(fileId, seq, ciphertextLength);
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    key,
    plaintext as BufferSource,
  );
  return new Uint8Array(sealed);
}

export interface OpenOptions {
  key: CryptoKey;
  fileId: number;
  seq: number;
  salt: Uint8Array;
  ciphertext: Uint8Array;
}

export async function openChunk({ key, fileId, seq, salt, ciphertext }: OpenOptions): Promise<Uint8Array> {
  const nonce = buildNonce(salt, seq);
  const aad = buildAad(fileId, seq, ciphertext.length);
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(opened);
}

// --- join proof (docs/02 §2.3 / §4.1) --------------------------------------
export function joinProofInput(roomIdBytes: Uint8Array, guestNonce: string): Uint8Array {
  return concatBytes(utf8(JOIN_PREFIX), roomIdBytes, utf8(guestNonce));
}

export function computeJoinProof(roomKey: Uint8Array, roomIdBytes: Uint8Array, guestNonce: string): string {
  // HMAC-SHA256(roomKey, "join:" || roomId || guestNonce)
  return base64urlEncode(hmac(sha256, roomKey, joinProofInput(roomIdBytes, guestNonce)));
}

export function verifyJoinProof(
  roomKey: Uint8Array,
  roomIdBytes: Uint8Array,
  guestNonce: string,
  proof: string | undefined,
): boolean {
  if (!proof) return false;
  let received: Uint8Array;
  try {
    received = base64urlDecode(proof);
  } catch {
    return false;
  }
  return timingSafeEqual(received, hmac(sha256, roomKey, joinProofInput(roomIdBytes, guestNonce)));
}

// --- incremental SHA-256 (docs/02 §4.4) ------------------------------------
export class IncrementalSha256 {
  private hasher = sha256.create();
  private bytesHashed = 0;

  update(bytes: Uint8Array): void {
    this.hasher.update(bytes);
    this.bytesHashed += bytes.length;
  }

  get length(): number {
    return this.bytesHashed;
  }

  digestBytes(): Uint8Array {
    return this.hasher.digest();
  }

  digestHex(): string {
    return bytesToHex(this.digestBytes());
  }

  /** Digest without destroying the running hash (safe to poll while receiving). */
  peekDigestHex(): string {
    return bytesToHex(this.hasher.clone().digest());
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

// --- SAS: 4 emoji from both DTLS fingerprints (docs/02 §4.5) ---------------
/** 64 stable emoji; index = (sasBits[i] >> 2) & 0x3f, i.e. 24 bits total. */
export const EMOJI_64 = [
  "🔒", "🔑", "🛡️", "🧩", "🚀", "🛰️", "📡", "🔗",
  "🧭", "🎯", "🧪", "🧬", "🔭", "🪐", "🌍", "🌤️",
  "🌊", "🔥", "❄️", "⚡", "🌈", "☀️", "🌙", "⭐",
  "🌟", "💫", "✨", "🍀", "🌵", "🌲", "🌴", "🌿",
  "🍎", "🍊", "🍋", "🍇", "🍓", "🫐", "🍑", "🥝",
  "🍒", "🥑", "🌽", "🥕", "🍄", "🧀", "🍞", "🥐",
  "🍳", "🍕", "🍔", "🍟", "🍿", "🍩", "🍪", "🎂",
  "🍫", "🍬", "🍭", "☕", "🍵", "🧃", "🥤", "🍷",
] as const;

/** Pull the sha-256 fingerprint out of an SDP (`a=fingerprint:sha-256 AB:CD:…`). */
export function parseDtlsFingerprint(sdp: string): string | null {
  const match = /a=fingerprint:sha-256\s+([0-9a-fA-F:]+)/.exec(sdp);
  return match ? match[1]!.toUpperCase() : null;
}

export function computeSas(fingerprintLocal: string, fingerprintRemote: string): string[] {
  const h1 = bytesToHex(sha256(utf8(fingerprintLocal.toUpperCase())));
  const h2 = bytesToHex(sha256(utf8(fingerprintRemote.toUpperCase())));
  const [a, b] = h1 <= h2 ? [h1, h2] : [h2, h1];
  const bits = hkdf(sha256, utf8(a + b), new Uint8Array(0), utf8(SAS_INFO), 4);
  return [0, 1, 2, 3].map((i) => EMOJI_64[(bits[i]! >> 2) & 0x3f]!);
}
