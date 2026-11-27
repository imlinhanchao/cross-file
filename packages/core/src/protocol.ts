/**
 * Protocol v2: signaling messages, control messages, chunk frames.
 *
 * Sources: docs/02-protocol.md §3 (signaling), §5 (capabilities), §6 (transfer),
 * and ADR 0010 (rooms whose members may transfer to each other, two phases).
 *
 * v2 is deliberately **not** backwards compatible with v1 (ADR 0010): the
 * signaling server rejects v1 connections with `VERSION_MISMATCH` instead of
 * degrading silently. `MemberInfo` replaces the v1 host/guest split, and every
 * transfer-scoped control message carries a `transferId` so two members can
 * exchange files in both directions over one pair of data channels.
 */
import { z } from "zod";
import {
  concatBytes,
  readU16le,
  readU32le,
  u16be,
  u32be,
  writeU16le,
  writeU32le,
} from "./bytes.js";

export const PROTOCOL_VERSION = 2 as const;

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
export function effectiveChunkSize(
  requested: number,
  maxMessageSize = 262_144,
): number {
  const capped = Math.min(requested, CHUNK_MAX);
  const byMessage = maxMessageSize - FRAME_HEADER_BYTES - GCM_TAG_BYTES;
  const size = Math.min(capped, byMessage);
  if (size < 1024)
    throw new Error(
      `channel maxMessageSize ${maxMessageSize} leaves no room for a chunk`,
    );
  return size;
}
export const HWM = 8 * 1024 * 1024;
export const LWM = 2 * 1024 * 1024;
export const RECONNECT_WINDOW_MS = 60_000;
export const ROOM_TTL_MS = 30 * 60_000;
/**
 * Signaling-socket heartbeat (docs/02 §10.1): the admin renews the room every
 * 20 s over `/v1/ws`. Not to be confused with the per-pair ctrl heartbeat below.
 */
export const HEARTBEAT_MS = 20_000;
/**
 * Application-level heartbeat on an open `ctrl` data channel (docs/02 §10.2
 * implementation note): ping every 3 s, declare the pair lost after ~10 s with
 * no frame received at all. Faster than waiting for a WebRTC close event (5–30 s)
 * and it can catch a frozen page that still holds the channel open.
 */
export const CTRL_HEARTBEAT_MS = 3_000;
export const CTRL_TIMEOUT_MS = 10_000;
export const TURN_TTL_SEC = 3_600;
/** Room capacity: the admin plus up to MAX_MEMBERS - 1 joiners (docs/01 D6, ADR 0010). */
export const MAX_MEMBERS = 4;

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
  "VERSION_MISMATCH",
  "NOT_ADMIN",
  /** ctrl-level: the receiving side is already running a transfer on this pair; the
   *  sender queues and retries once the pair is idle (docs/02 §6.3). */
  "BUSY",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// --- capabilities (docs/02 §5) ---------------------------------------------
export const SAVE_STRATEGIES = ["native", "fs", "sw", "blob"] as const;
export type SaveStrategy = (typeof SAVE_STRATEGIES)[number];

export const UAFamilies = [
  "chrome",
  "edge",
  "safari",
  "firefox",
  "arkweb",
  "unknown",
] as const;
export type UAFamily = (typeof UAFamilies)[number];

export const Platforms = [
  "win",
  "mac",
  "linux",
  "ios",
  "android",
  "harmony",
  "unknown",
] as const;
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

// --- room membership (ADR 0010) ---------------------------------------------
/** A member whose socket is gone but whose 60 s reconnect window is still open. */
export type MemberState = "joined" | "offline";

/**
 * One entry of the room's member list, as broadcast by the signaling server.
 * `isAdmin` marks the room's current admin (the creator in phase 1; after a
 * hand-over in phase 2 it is the earliest-joined online member).
 */
export interface MemberInfo {
  id: string;
  name: string;
  caps: Caps;
  isAdmin: boolean;
  state: MemberState;
}

export const memberInfoSchema: z.ZodType<MemberInfo> = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  caps: capsSchema,
  isAdmin: z.boolean(),
  state: z.enum(["joined", "offline"]),
});

/** Signaling display name: 1-16 code points, normalised client side (identity.ts). */
const displayNameSchema = z.string().min(1).max(64);

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
  | { v: 2; type: "hello"; clientCaps?: Caps }
  | { v: 2; type: "create"; roomId: string; caps: Caps; name: string }
  | {
      v: 2;
      type: "join";
      roomId: string;
      caps: Caps;
      nonce: string;
      proof?: string;
      /** set when a member reconnects inside the 60 s window (ADR 0010 §reconnect) */
      rejoinToken?: string;
    }
  | { v: 2; type: "approve"; memberId: string }
  | { v: 2; type: "deny"; memberId: string; reason?: string }
  | { v: 2; type: "remove"; memberId: string }
  | { v: 2; type: "signal"; to: string; payload: SignalPayload }
  | { v: 2; type: "profile"; name: string }
  | { v: 2; type: "heartbeat"; roomId: string }
  | { v: 2; type: "close"; roomId: string; reason?: string };

export type ServerMessage =
  | {
      v: 2;
      type: "created";
      roomId: string;
      /** 6 digit join code */ code: string;
      /** the creator's own peer id */
      selfId: string;
      name: string;
      members: MemberInfo[];
      /** opaque token used to reconnect with the same identity inside 60 s */
      rejoinToken: string;
      turn?: TurnCredential;
    }
  | {
      v: 2;
      type: "join_request";
      memberId: string;
      caps: Caps;
      nonce: string;
      proof?: string;
      name: string;
    }
  | {
      v: 2;
      type: "join_ok";
      roomId: string;
      selfId: string;
      name: string;
      members: MemberInfo[];
      rejoinToken: string;
      turn?: TurnCredential;
    }
  | { v: 2; type: "join_rejected"; code: ErrorCode; reason: string }
  /** full member list after any join/leave/name change/state change */
  | { v: 2; type: "members"; members: MemberInfo[] }
  | { v: 2; type: "signal"; from: string; payload: SignalPayload }
  | { v: 2; type: "member_left"; memberId: string }
  | {
      v: 2;
      type: "room_closed";
      reason: "admin_close" | "ttl" | "error";
    }
  | {
      v: 2;
      type: "turn";
      uris: string[];
      username: string;
      credential: string;
      ttl: number;
    }
  | { v: 2; type: "error"; code: ErrorCode; msg: string };

/** Thrown by {@link parseClientMessage} when a peer speaks a different protocol version. */
export class VersionMismatchError extends Error {
  readonly received: unknown;

  constructor(received: unknown) {
    super(
      `unsupported protocol version: ${String(received)} (expected ${PROTOCOL_VERSION})`,
    );
    this.name = "VersionMismatchError";
    this.received = received;
  }
}

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

const base = { v: z.literal(2) } as const;

export const clientMessageSchema: z.ZodType<ClientMessage> =
  z.discriminatedUnion("type", [
    z.object({
      ...base,
      type: z.literal("hello"),
      clientCaps: capsSchema.optional(),
    }),
    z.object({
      ...base,
      type: z.literal("create"),
      roomId: z.string().regex(/^[a-z2-7]{26}$/),
      caps: capsSchema,
      name: displayNameSchema,
    }),
    z.object({
      ...base,
      type: z.literal("join"),
      roomId: z.string().regex(/^[a-z2-7]{26}$/),
      caps: capsSchema,
      nonce: z.string().min(8).max(64),
      proof: z.string().min(1).max(128).optional(),
      rejoinToken: z.string().min(1).max(128).optional(),
    }),
    z.object({
      ...base,
      type: z.literal("approve"),
      memberId: z.string().min(1),
    }),
    z.object({
      ...base,
      type: z.literal("deny"),
      memberId: z.string().min(1),
      reason: z.string().max(200).optional(),
    }),
    z.object({
      ...base,
      type: z.literal("remove"),
      memberId: z.string().min(1),
    }),
    z.object({
      ...base,
      type: z.literal("signal"),
      to: z.string().min(1),
      payload: signalPayloadSchema,
    }),
    z.object({
      ...base,
      type: z.literal("profile"),
      name: displayNameSchema,
    }),
    z.object({
      ...base,
      type: z.literal("heartbeat"),
      roomId: z.string().min(1),
    }),
    z.object({
      ...base,
      type: z.literal("close"),
      roomId: z.string().min(1),
      reason: z.string().max(200).optional(),
    }),
  ]) as z.ZodType<ClientMessage>;

export function parseClientMessage(raw: unknown): ClientMessage {
  if (raw !== null && typeof raw === "object" && "v" in raw) {
    const version = (raw as { v?: unknown }).v;
    if (version !== PROTOCOL_VERSION) throw new VersionMismatchError(version);
  }
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

/**
 * Transfer-scoped id. Two members may exchange files in both directions over the
 * same pair of data channels (ADR 0010 §concurrency), so `fileId` — allocated by
 * each sender from 1 — is only unique inside one transfer.
 */
const transferIdSchema = z.string().min(1).max(128);

export interface Manifest {
  v: 2;
  type: "manifest";
  transferId: string;
  files: FileManifestEntry[];
  totalSize: number;
  chunkNegotiation: { min: number; max: number };
}

export type CtrlMessage =
  | { v: 2; type: "hello"; caps: Caps }
  | Manifest
  | { v: 2; type: "accept"; transferId: string; fileIds: number[] }
  | { v: 2; type: "bitmap"; transferId: string; fileId: number; bits: string }
  | {
      v: 2;
      type: "progress";
      transferId: string;
      fileId: number;
      seq: number;
    }
  | {
      v: 2;
      type: "done";
      transferId: string;
      fileId: number;
      sha256: string;
      chunkCount: number;
    }
  | {
      v: 2;
      type: "ack";
      transferId: string;
      fileId: number;
      ok: boolean;
      error?: string;
    }
  | {
      v: 2;
      type: "error";
      transferId?: string;
      code: ErrorCode;
      msg: string;
      fileId?: number;
    }
  | { v: 2; type: "pause"; transferId: string }
  | { v: 2; type: "resume"; transferId: string }
  /**
   * User cancel (docs/02 §10.2 implementation note, v0.4.0): one-way "stop this
   * transfer" notice. The receiving side stops it, drops the half-received data
   * and returns the pair to idle; the sender/receiver locally cleans up without
   * waiting for a reply. `transferId` is validated against the active transfer —
   * a stale/unknown id is ignored.
   */
  | { v: 2; type: "cancel"; transferId: string; reason?: string }
  /**
   * Channel-level heartbeat (no `transferId`): ping every 3 s, reply pong. Any
   * frame received counts as activity.
   */
  | { v: 2; type: "ping" }
  | { v: 2; type: "pong" }
  /**
   * 6-digit-code path only (docs/02 §3.5): the guest joins without the roomKey in
   * the fragment, so the key is handed over the encrypted data channel after both
   * sides confirm the 4-emoji SAS. These message shapes are not fixed by docs/02
   * and are recorded as an implementation note in docs/05 §7.
   */
  | { v: 2; type: "sas-confirm" }
  | { v: 2; type: "room-key"; key: string; roomId: string }
  | { v: 2; type: "key-ok" };

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
  v: z.literal(2),
  type: z.literal("manifest"),
  transferId: transferIdSchema,
  files: z.array(manifestEntrySchema).min(1).max(256),
  totalSize: z.number().int().nonnegative(),
  chunkNegotiation: z.object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  }),
});

export const ctrlMessageSchema: z.ZodType<CtrlMessage> = z.union([
  z.object({
    v: z.literal(2),
    type: z.literal("hello"),
    caps: capsSchema,
  }),
  manifestSchema as unknown as z.ZodType<Manifest>,
  z.object({
    v: z.literal(2),
    type: z.literal("accept"),
    transferId: transferIdSchema,
    fileIds: z.array(z.number().int()).max(256),
  }),
  z.object({
    v: z.literal(2),
    type: z.literal("bitmap"),
    transferId: transferIdSchema,
    fileId: z.number().int(),
    bits: z.string(),
  }),
  z.object({
    v: z.literal(2),
    type: z.literal("progress"),
    transferId: transferIdSchema,
    fileId: z.number().int(),
    seq: z.number().int(),
  }),
  z.object({
    v: z.literal(2),
    type: z.literal("done"),
    transferId: transferIdSchema,
    fileId: z.number().int(),
    sha256: z.string().length(64),
    chunkCount: z.number().int(),
  }),
  z.object({
    v: z.literal(2),
    type: z.literal("ack"),
    transferId: transferIdSchema,
    fileId: z.number().int(),
    ok: z.boolean(),
    error: z.string().max(200).optional(),
  }),
  z.object({
    v: z.literal(2),
    type: z.literal("error"),
    transferId: transferIdSchema.optional(),
    code: z.enum(ERROR_CODES),
    msg: z.string().max(500),
    fileId: z.number().int().optional(),
  }),
  z.object({
    v: z.literal(2),
    type: z.literal("pause"),
    transferId: transferIdSchema,
  }),
  z.object({
    v: z.literal(2),
    type: z.literal("resume"),
    transferId: transferIdSchema,
  }),
  z.object({
    v: z.literal(2),
    type: z.literal("cancel"),
    transferId: transferIdSchema,
    reason: z.string().max(200).optional(),
  }),
  z.object({ v: z.literal(2), type: z.literal("ping") }),
  z.object({ v: z.literal(2), type: z.literal("pong") }),
  z.object({ v: z.literal(2), type: z.literal("sas-confirm") }),
  z.object({
    v: z.literal(2),
    type: z.literal("room-key"),
    key: z.string().min(1).max(128),
    roomId: z.string().min(1).max(64),
  }),
  z.object({ v: z.literal(2), type: z.literal("key-ok") }),
]) as z.ZodType<CtrlMessage>;

/**
 * Parse one ctrl frame. Unknown `type`s (or fields) throw: the web layer catches
 * the error and silently drops the frame, so a message type this build does not
 * know never breaks an open pair.
 */
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
  if (len > CHUNK_MAX_CIPHERTEXT)
    throw new Error(`chunk ciphertext too large: ${len}`);
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
  if (data.length > FRAME_MAX_BYTES)
    throw new Error(`frame too large: ${data.length}`);
  const type = data[0];
  if (type !== FRAME_TYPE_CHUNK) throw new Error(`unknown frame type: ${type}`);
  const fileId = readU16le(data, 1);
  const seq = readU32le(data, 3);
  const len = readU32le(data, 7);
  const flags = data[11]!;
  if (len > CHUNK_MAX_CIPHERTEXT) throw new Error(`bad length: ${len}`);
  if (FRAME_HEADER_BYTES + len !== data.length)
    throw new Error("frame length mismatch");
  return {
    fileId,
    seq,
    last: (flags & FRAME_FLAG_LAST) !== 0,
    ciphertext: data.subarray(FRAME_HEADER_BYTES),
  };
}

// --- helpers ----------------------------------------------------------------
export function chunkAad(
  fileId: number,
  seq: number,
  ciphertextLen: number,
): Uint8Array {
  return concatBytes(u16be(fileId), u32be(seq), u32be(ciphertextLen));
}
