/**
 * Protocol v1: signaling messages, control messages, chunk frames.
 *
 * Sources: docs/02-protocol.md §3 (signaling), §5 (capabilities), §6 (transfer).
 * Field names not fixed by that document are declared here and recorded as an
 * implementation note in docs/05-development-plan.md §7.
 */
import { z } from "zod";
import { concatBytes, readU16le, readU32le, u16be, u32be, writeU16le, writeU32le } from "./bytes.js";

export const PROTOCOL_VERSION = 1 as const;

// --- constants (docs/02 §1) -------------------------------------------------
export const CHUNK_MIN = 64 * 1024;
export const CHUNK_MAX = 256 * 1024;
export const CHUNK_MAX_CIPHERTEXT = 262_144;
export const FRAME_HEADER_BYTES = 12;
export const FRAME_MAX_BYTES = FRAME_HEADER_BYTES + CHUNK_MAX_CIPHERTEXT;
export const GCM_TAG_BYTES = 16;

/**
 * Plaintext chunk size that actually fits the channel: `sctp.maxMessageSize`
 * covers the whole frame (header + ciphertext + tag), docs/02 §4.3/§6.2.
 */
export function effectiveChunkSize(requested: number, maxMessageSize = 262_144): number {
  const capped = Math.min(requested, CHUNK_MAX);
  const byMessage = maxMessageSize - FRAME_HEADER_BYTES - GCM_TAG_BYTES;
  const size = Math.min(capped, byMessage);
  if (size < 1024) throw new Error(`channel maxMessageSize ${maxMessageSize} leaves no room for a chunk`);
  return size;
}
export const HWM = 8 * 1024 * 1024;
export const LWM = 2 * 1024 * 1024;
export const RECONNECT_WINDOW_MS = 60_000;
export const ROOM_TTL_MS = 30 * 60_000;
export const HEARTBEAT_MS = 20_000;
export const TURN_TTL_SEC = 3_600;
export const MAX_GUESTS = 4;

// --- error codes (docs/02 §3.6) --------------------------------------------
export const ERROR_CODES = [
  "ROOM_NOT_FOUND",
  "ROOM_CLOSED",
  "ROOM_FULL",
  "PROOF_INVALID",
  "SAS_MISMATCH",
  "TOO_LARGE",
  "CAPABILITY_RISK_DECLINED",
  "HASH_MISMATCH",
  "TIMEOUT",
  "PEER_GONE",
  "RATE_LIMITED",
  "BAD_MESSAGE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// --- capabilities (docs/02 §5) ---------------------------------------------
export const SAVE_STRATEGIES = ["native", "fs", "sw", "blob"] as const;
export type SaveStrategy = (typeof SAVE_STRATEGIES)[number];

export const UAFamilies = ["chrome", "edge", "safari", "firefox", "arkweb", "unknown"] as const;
export type UAFamily = (typeof UAFamilies)[number];

export const Platforms = ["win", "mac", "linux", "ios", "android", "harmony", "unknown"] as const;
export type Platform = (typeof Platforms)[number];

export interface Caps {
  platform: Platform;
  uaFamily: UAFamily;
  nativeShell: boolean;
  secureContext: boolean;
  fsAccess: boolean;
  sw: boolean;
  swDownload: boolean;
  saveStrategies: SaveStrategy[];
  deviceMemoryGB?: number;
  storageQuotaMB?: number;
  screen: "phone" | "tablet" | "desktop";
}

export const capsSchema: z.ZodType<Caps> = z.object({
  platform: z.enum(Platforms),
  uaFamily: z.enum(UAFamilies),
  nativeShell: z.boolean(),
  secureContext: z.boolean(),
  fsAccess: z.boolean(),
  sw: z.boolean(),
  swDownload: z.boolean(),
  saveStrategies: z.array(z.enum(SAVE_STRATEGIES)).min(1),
  deviceMemoryGB: z.number().positive().optional(),
  storageQuotaMB: z.number().positive().optional(),
  screen: z.enum(["phone", "tablet", "desktop"]),
});

// --- signaling (client <-> S, docs/02 §3.2) ---------------------------------
export type SignalPayload =
  | { k: "offer"; sdp: string }
  | { k: "answer"; sdp: string }
  | { k: "candidate"; candidate: RTCIceCandidateInitLike };

export interface RTCIceCandidateInitLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface TurnCredential {
  uris: string[];
  username: string;
  credential: string;
  ttl: number;
}

export type ClientMessage =
  | { v: 1; type: "hello"; clientCaps?: Caps }
  | { v: 1; type: "create"; roomId: string; hostCaps: Caps }
  | { v: 1; type: "join"; roomId: string; guestCaps: Caps; guestNonce: string; proof?: string }
  | { v: 1; type: "approve"; guestId: string }
  | { v: 1; type: "deny"; guestId: string; reason?: string }
  | { v: 1; type: "remove"; guestId: string }
  | { v: 1; type: "signal"; to: string; payload: SignalPayload }
  | { v: 1; type: "heartbeat"; roomId: string }
  | { v: 1; type: "close"; roomId: string; reason?: string };

export type ServerMessage =
  | { v: 1; type: "created"; roomId: string; /** 6 digit join code */ code: string; turn?: TurnCredential }
  | {
      v: 1;
      type: "join_request";
      guestId: string;
      guestCaps: Caps;
      guestNonce: string;
      proof?: string;
    }
  | { v: 1; type: "join_ok"; guestId: string; peerCaps: Caps; turn?: TurnCredential }
  | { v: 1; type: "join_rejected"; code: ErrorCode; reason: string }
  | { v: 1; type: "signal"; from: string; payload: SignalPayload }
  | { v: 1; type: "peer_left"; guestId: string }
  | { v: 1; type: "room_closed"; reason: "host_close" | "ttl" | "error" }
  | { v: 1; type: "turn"; uris: string[]; username: string; credential: string; ttl: number }
  | { v: 1; type: "error"; code: ErrorCode; msg: string };

const signalPayloadSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("offer"), sdp: z.string().min(1) }),
  z.object({ k: z.literal("answer"), sdp: z.string().min(1) }),
  z.object({
    k: z.literal("candidate"),
    candidate: z.object({
      candidate: z.string(),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    }),
  }),
]);

const base = { v: z.literal(1) } as const;

export const clientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("hello"), clientCaps: capsSchema.optional() }),
  z.object({ ...base, type: z.literal("create"), roomId: z.string().regex(/^[a-z2-7]{26}$/), hostCaps: capsSchema }),
  z.object({
    ...base,
    type: z.literal("join"),
    roomId: z.string().regex(/^[a-z2-7]{26}$/),
    guestCaps: capsSchema,
    guestNonce: z.string().min(8).max(64),
    proof: z.string().min(1).max(128).optional(),
  }),
  z.object({ ...base, type: z.literal("approve"), guestId: z.string().min(1) }),
  z.object({ ...base, type: z.literal("deny"), guestId: z.string().min(1), reason: z.string().max(200).optional() }),
  z.object({ ...base, type: z.literal("remove"), guestId: z.string().min(1) }),
  z.object({ ...base, type: z.literal("signal"), to: z.string().min(1), payload: signalPayloadSchema }),
  z.object({ ...base, type: z.literal("heartbeat"), roomId: z.string().min(1) }),
  z.object({ ...base, type: z.literal("close"), roomId: z.string().min(1), reason: z.string().max(200).optional() }),
]) as z.ZodType<ClientMessage>;

export function parseClientMessage(raw: unknown): ClientMessage {
  return clientMessageSchema.parse(raw);
}

// --- control channel messages (docs/02 §6.4) --------------------------------
export interface FileManifestEntry {
  id: number;
  name: string;
  size: number;
  mime: string;
  chunk: number;
  chunkCount: number;
  /** base64 of the 4 byte per-file salt. */
  salt: string;
}

export interface Manifest {
  v: 1;
  type: "manifest";
  files: FileManifestEntry[];
  totalSize: number;
  chunkNegotiation: { min: number; max: number };
}

export type CtrlMessage =
  | { v: 1; type: "hello"; guestCaps: Caps }
  | Manifest
  | { v: 1; type: "accept"; fileIds: number[] }
  | { v: 1; type: "bitmap"; fileId: number; bits: string }
  | { v: 1; type: "progress"; fileId: number; seq: number }
  | { v: 1; type: "done"; fileId: number; sha256: string; chunkCount: number }
  | { v: 1; type: "ack"; fileId: number; ok: boolean; error?: string }
  | { v: 1; type: "error"; code: ErrorCode; msg: string; fileId?: number }
  | { v: 1; type: "pause" }
  | { v: 1; type: "resume" }
  /**
   * 6-digit-code path only (docs/02 §3.5): the guest joins without the roomKey in
   * the fragment, so the key is handed over the encrypted data channel after both
   * sides confirm the 4-emoji SAS. These message shapes are not fixed by docs/02
   * and are recorded as an implementation note in docs/05 §7.
   */
  | { v: 1; type: "sas-confirm" }
  | { v: 1; type: "room-key"; key: string; roomId: string }
  | { v: 1; type: "key-ok" };

const manifestEntrySchema = z.object({
  id: z.number().int().min(1).max(65535),
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  mime: z.string().max(255),
  chunk: z.number().int().min(CHUNK_MIN).max(CHUNK_MAX),
  chunkCount: z.number().int().min(0),
  salt: z.string().min(1).max(16),
});

export const manifestSchema = z.object({
  v: z.literal(1),
  type: z.literal("manifest"),
  files: z.array(manifestEntrySchema).min(1).max(256),
  totalSize: z.number().int().nonnegative(),
  chunkNegotiation: z.object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  }),
});

export const ctrlMessageSchema: z.ZodType<CtrlMessage> = z.union([
  z.object({ v: z.literal(1), type: z.literal("hello"), guestCaps: capsSchema }),
  manifestSchema as unknown as z.ZodType<Manifest>,
  z.object({ v: z.literal(1), type: z.literal("accept"), fileIds: z.array(z.number().int()).max(256) }),
  z.object({ v: z.literal(1), type: z.literal("bitmap"), fileId: z.number().int(), bits: z.string() }),
  z.object({ v: z.literal(1), type: z.literal("progress"), fileId: z.number().int(), seq: z.number().int() }),
  z.object({
    v: z.literal(1),
    type: z.literal("done"),
    fileId: z.number().int(),
    sha256: z.string().length(64),
    chunkCount: z.number().int(),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("ack"),
    fileId: z.number().int(),
    ok: z.boolean(),
    error: z.string().max(200).optional(),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("error"),
    code: z.enum(ERROR_CODES),
    msg: z.string().max(500),
    fileId: z.number().int().optional(),
  }),
  z.object({ v: z.literal(1), type: z.literal("pause") }),
  z.object({ v: z.literal(1), type: z.literal("resume") }),
  z.object({ v: z.literal(1), type: z.literal("sas-confirm") }),
  z.object({ v: z.literal(1), type: z.literal("room-key"), key: z.string().min(1).max(128), roomId: z.string().min(1).max(64) }),
  z.object({ v: z.literal(1), type: z.literal("key-ok") }),
]) as z.ZodType<CtrlMessage>;

export function parseCtrlMessage(raw: unknown): CtrlMessage {
  return ctrlMessageSchema.parse(raw);
}

export function chunkCountFor(size: number, chunkSize: number): number {
  return size === 0 ? 1 : Math.ceil(size / chunkSize);
}

// --- chunk frame (docs/02 §6.2, little endian) ------------------------------
export interface ChunkFrame {
  fileId: number;
  seq: number;
  last: boolean;
  /** ciphertext including the 16 byte GCM tag */
  ciphertext: Uint8Array;
}

export const FRAME_TYPE_CHUNK = 1;
export const FRAME_FLAG_LAST = 1;

export function encodeChunkFrame(frame: ChunkFrame): Uint8Array {
  const len = frame.ciphertext.length;
  if (len > CHUNK_MAX_CIPHERTEXT) throw new Error(`chunk ciphertext too large: ${len}`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + len);
  const view = new DataView(out.buffer);
  out[0] = FRAME_TYPE_CHUNK;
  writeU16le(view, 1, frame.fileId);
  writeU32le(view, 3, frame.seq);
  writeU32le(view, 7, len);
  out[11] = frame.last ? FRAME_FLAG_LAST : 0;
  out.set(frame.ciphertext, FRAME_HEADER_BYTES);
  return out;
}

export function decodeChunkFrame(data: Uint8Array): ChunkFrame {
  if (data.length < FRAME_HEADER_BYTES) throw new Error("frame too short");
  if (data.length > FRAME_MAX_BYTES) throw new Error(`frame too large: ${data.length}`);
  const type = data[0];
  if (type !== FRAME_TYPE_CHUNK) throw new Error(`unknown frame type: ${type}`);
  const fileId = readU16le(data, 1);
  const seq = readU32le(data, 3);
  const len = readU32le(data, 7);
  const flags = data[11]!;
  if (len > CHUNK_MAX_CIPHERTEXT) throw new Error(`bad length: ${len}`);
  if (FRAME_HEADER_BYTES + len !== data.length) throw new Error("frame length mismatch");
  return {
    fileId,
    seq,
    last: (flags & FRAME_FLAG_LAST) !== 0,
    ciphertext: data.subarray(FRAME_HEADER_BYTES),
  };
}

// --- helpers ----------------------------------------------------------------
export function chunkAad(fileId: number, seq: number, ciphertextLen: number): Uint8Array {
  return concatBytes(u16be(fileId), u32be(seq), u32be(ciphertextLen));
}
