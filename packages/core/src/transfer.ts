/** Chunk sending / receiving over an ordered reliable data channel (docs/02 §6). */
import { coerceBytes } from "./bytes.js";
import { IncrementalSha256, openChunk, sealChunk } from "./crypto.js";
import {
  chunkCountFor,
  decodeChunkFrame,
  effectiveChunkSize,
  encodeChunkFrame,
  CHUNK_MAX,
  HWM,
  LWM,
  type ChunkFrame,
} from "./protocol.js";

export interface DataChannelLike {
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer | Uint8Array): void;
  addEventListener?(type: "bufferedamountlow", listener: () => void): void;
  removeEventListener?(type: "bufferedamountlow", listener: () => void): void;
  readonly readyState?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the channel drains below its low watermark. Resolves immediately if already low. */
export function waitForDrain(
  channel: DataChannelLike,
  lowWaterMark = LWM,
  timeoutMs = 15_000,
): Promise<void> {
  if (channel.bufferedAmount <= lowWaterMark) return Promise.resolve();
  const addListener = channel.addEventListener;
  if (!addListener) {
    return sleep(5).then(() => waitForDrain(channel, lowWaterMark, timeoutMs));
  }
  const removeListener = channel.removeEventListener;
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      removeListener?.("bufferedamountlow", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    channel.bufferedAmountLowThreshold = lowWaterMark;
    addListener.call(channel, "bufferedamountlow", finish);
  });
}

export async function waitForCapacity(
  channel: DataChannelLike,
  highWaterMark = HWM,
): Promise<void> {
  while (channel.bufferedAmount > highWaterMark) {
    await waitForDrain(channel);
  }
}

export interface SendFileOptions {
  fileId: number;
  file: Blob;
  chunkSize: number;
  salt: Uint8Array;
  key: CryptoKey;
  channel: DataChannelLike;
  highWaterMark?: number;
  lowWaterMark?: number;
  /** resolves when a pause request (ctrl: pause) can be lifted */
  waitIfPaused?: () => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (sentBytes: number, totalBytes: number, seq: number) => void;
  progressEveryChunks?: number;
  /** sctp.maxMessageSize of the current pair; frames are clamped to fit it */
  maxMessageSize?: number;
  /**
   * Resume support (docs/02 §6.5): send only these chunk indexes. `seq` and the
   * derived nonce never change, so a re-sent chunk is byte-identical.
   */
  onlyChunks?: number[] | Set<number>;
  /** Set false when the caller already owns the whole-file digest (resume path). */
  computeHash?: boolean;
}

export interface SendFileResult {
  sha256: string;
  chunkCount: number;
  bytes: number;
  /** chunk size actually used; the manifest must advertise this value */
  chunkSize: number;
  /** chunks actually transmitted by this call */
  sentChunks: number;
}

export async function sendFile(
  options: SendFileOptions,
): Promise<SendFileResult> {
  const {
    fileId,
    file,
    chunkSize,
    salt,
    key,
    channel,
    highWaterMark = HWM,
    lowWaterMark = LWM,
    waitIfPaused,
    signal,
    onProgress,
    progressEveryChunks = 100,
    maxMessageSize = 262_144,
    onlyChunks,
    computeHash = true,
  } = options;

  const effective = effectiveChunkSize(chunkSize, maxMessageSize);
  const totalBytes = file.size;
  const chunkCount = chunkCountFor(totalBytes, effective);
  const hasher = new IncrementalSha256();
  let sentBytes = 0;
  let sentChunks = 0;
  const seqs = onlyChunks
    ? [...onlyChunks]
        .filter((seq) => seq >= 0 && seq < chunkCount)
        .sort((a, b) => a - b)
    : Array.from({ length: chunkCount }, (_, index) => index);

  for (const seq of seqs) {
    if (signal?.aborted) throw new Error("send aborted");
    if (waitIfPaused) await waitIfPaused();

    const start = seq * effective;
    const end = Math.min(totalBytes, start + effective);
    const plaintext = new Uint8Array(
      await file.slice(start, end).arrayBuffer(),
    );
    if (plaintext.length > CHUNK_MAX)
      throw new Error(`chunk too large: ${plaintext.length}`);
    if (computeHash) hasher.update(plaintext);

    const ciphertext = await sealChunk({ key, fileId, seq, salt, plaintext });
    const frame = encodeChunkFrame({
      fileId,
      seq,
      last: seq === chunkCount - 1,
      ciphertext,
    });

    await waitForCapacity(channel, highWaterMark);
    if (channel.readyState && channel.readyState !== "open")
      throw new Error("data channel closed");
    channel.send(frame);

    sentBytes += plaintext.length;
    sentChunks += 1;
    if (seq % progressEveryChunks === 0 || seq === chunkCount - 1) {
      onProgress?.(sentBytes, totalBytes, seq);
    }
  }

  if (lowWaterMark > 0) {
    // let the channel drain before the control message `done` follows
    await waitForDrain(channel, lowWaterMark);
  }
  return {
    sha256: computeHash ? hasher.digestHex() : "",
    chunkCount,
    bytes: totalBytes,
    chunkSize: effective,
    sentChunks,
  };
}

// --- receiving --------------------------------------------------------------
export interface ChunkBitmaps {
  /** base64, 1 bit per chunk, 1 = received (docs/02 §6.5) */
  encode(received: ReadonlySet<number>, chunkCount: number): string;
}

export function encodeBitmap(
  received: ReadonlySet<number>,
  chunkCount: number,
): string {
  const bytes = new Uint8Array(Math.ceil(chunkCount / 8));
  for (const seq of received) {
    if (seq < 0 || seq >= chunkCount) continue;
    bytes[seq >> 3]! |= 1 << (seq & 7);
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeBitmap(bits: string, chunkCount: number): Set<number> {
  const raw = atob(bits);
  const received = new Set<number>();
  for (let seq = 0; seq < chunkCount; seq++) {
    const byte = raw.charCodeAt(seq >> 3);
    if (Number.isNaN(byte)) continue;
    if ((byte >> (seq & 7)) & 1) received.add(seq);
  }
  return received;
}

export interface ChunkReceiverOptions {
  fileId: number;
  size: number;
  chunkSize: number;
  chunkCount?: number;
  salt: Uint8Array;
  key: CryptoKey;
  /** stream decrypted bytes to a sink; when omitted they are collected in memory */
  onChunk?: (offset: number, plaintext: Uint8Array) => void | Promise<void>;
  onProgress?: (receivedBytes: number, totalBytes: number, seq: number) => void;
  progressEveryChunks?: number;
}

export class ChunkReceiver {
  readonly fileId: number;
  readonly size: number;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly received = new Set<number>();

  private readonly salt: Uint8Array;
  private readonly key: CryptoKey;
  private readonly onChunk?: ChunkReceiverOptions["onChunk"];
  private readonly onProgress?: ChunkReceiverOptions["onProgress"];
  private readonly progressEveryChunks: number;
  private readonly hasher = new IncrementalSha256();
  private readonly pendingHash = new Map<number, Uint8Array>();
  private readonly collected: Uint8Array[] = [];
  private nextHashSeq = 0;
  private receivedBytes = 0;
  private lastFrameSeen = false;

  constructor(options: ChunkReceiverOptions) {
    this.fileId = options.fileId;
    this.size = options.size;
    this.chunkSize = options.chunkSize;
    this.chunkCount =
      options.chunkCount ?? chunkCountFor(options.size, options.chunkSize);
    this.salt = options.salt;
    this.key = options.key;
    this.onChunk = options.onChunk;
    this.onProgress = options.onProgress;
    this.progressEveryChunks = options.progressEveryChunks ?? 100;
  }

  async handleFrame(frame: ChunkFrame): Promise<void> {
    if (frame.fileId !== this.fileId)
      throw new Error(`unexpected fileId ${frame.fileId}`);
    if (frame.seq >= this.chunkCount)
      throw new Error(`seq out of range: ${frame.seq}`);
    if (frame.last) this.lastFrameSeen = true;
    if (this.received.has(frame.seq)) return; // duplicate after a resume retry

    const plaintext = await openChunk({
      key: this.key,
      fileId: this.fileId,
      seq: frame.seq,
      salt: this.salt,
      ciphertext: frame.ciphertext,
    });

    const expectedLength = Math.min(
      this.chunkSize,
      this.size - frame.seq * this.chunkSize,
    );
    if (plaintext.length !== expectedLength) {
      throw new Error(
        `chunk ${frame.seq} length ${plaintext.length}, expected ${expectedLength}`,
      );
    }

    this.received.add(frame.seq);
    this.receivedBytes += plaintext.length;
    const offset = frame.seq * this.chunkSize;

    if (this.onChunk) {
      await this.onChunk(offset, plaintext);
    } else {
      this.collected.push(plaintext);
    }

    // Feed the whole-file digest strictly in chunk order.
    if (frame.seq === this.nextHashSeq) {
      this.hasher.update(plaintext);
      this.nextHashSeq++;
      for (
        let next = this.pendingHash.get(this.nextHashSeq);
        next;
        next = this.pendingHash.get(this.nextHashSeq)
      ) {
        this.pendingHash.delete(this.nextHashSeq);
        this.hasher.update(next);
        this.nextHashSeq++;
      }
    } else {
      this.pendingHash.set(frame.seq, plaintext);
    }

    if (
      frame.seq % this.progressEveryChunks === 0 ||
      this.received.size === this.chunkCount
    ) {
      this.onProgress?.(this.receivedBytes, this.size, frame.seq);
    }
  }

  missingChunks(): number[] {
    const missing: number[] = [];
    for (let seq = 0; seq < this.chunkCount; seq++)
      if (!this.received.has(seq)) missing.push(seq);
    return missing;
  }

  bitmap(): string {
    return encodeBitmap(this.received, this.chunkCount);
  }

  /** Bytes collected in memory (only when no onChunk sink was given). */
  collectBytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.collected) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /** True once every chunk arrived AND every chunk has been folded into the digest. */
  isComplete(): boolean {
    return (
      this.received.size === this.chunkCount &&
      this.nextHashSeq === this.chunkCount
    );
  }

  /**
   * Final digest. Non-destructive: callers may poll `isComplete()` and call this
   * only once, but a stray double call must not corrupt the running hash.
   */
  finish(): { sha256: string; size: number; complete: boolean } {
    return {
      sha256: this.hasher.peekDigestHex(),
      size: this.receivedBytes,
      complete: this.isComplete(),
    };
  }

  get sawLastFrame(): boolean {
    return this.lastFrameSeen;
  }
}

/** Convenience for one-shot in-memory transfers (M0/M1 blob sink path). */
export async function receiveWholeFile(
  options: Omit<ChunkReceiverOptions, "onChunk">,
  frames: AsyncIterable<Uint8Array | ArrayBuffer>,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const receiver = new ChunkReceiver(options);
  for await (const raw of frames) {
    const frame = decodeChunkFrame(coerceBytes(raw));
    await receiver.handleFrame(frame);
  }
  const result = receiver.finish();
  if (!result.complete) throw new Error("incomplete transfer");
  return { bytes: receiver.collectBytes(), sha256: result.sha256 };
}
