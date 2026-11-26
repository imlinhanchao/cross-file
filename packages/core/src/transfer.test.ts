import { describe, expect, it } from "vitest";
import { bytesToArrayBuffer, randomBytes } from "./bytes.js";
import {
  deriveFileKey,
  deriveSessionKey,
  importFileKey,
  sha256Hex,
} from "./crypto.js";
import {
  ChunkReceiver,
  decodeBitmap,
  encodeBitmap,
  sendFile,
  type DataChannelLike,
} from "./transfer.js";
import { decodeChunkFrame } from "./protocol.js";

const roomKey = new Uint8Array(32).fill(5);
const roomId = new Uint8Array(16).fill(6);
const salt = new Uint8Array([9, 8, 7, 6]);

class FakeChannel implements DataChannelLike {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = "open";
  readonly frames: Uint8Array[] = [];
  send(data: ArrayBuffer | Uint8Array): void {
    this.frames.push(
      (data instanceof Uint8Array ? data : new Uint8Array(data)).slice(),
    );
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

async function makeFile(
  size: number,
): Promise<{ blob: Blob; bytes: Uint8Array }> {
  const bytes = randomBytes(size);
  return { blob: new Blob([bytesToArrayBuffer(bytes)]), bytes };
}

async function keyFor(fileId: number): Promise<CryptoKey> {
  return importFileKey(
    deriveFileKey(deriveSessionKey(roomKey, roomId), "t1", fileId),
  );
}

describe("sendFile + ChunkReceiver", () => {
  it("transfers a multi-chunk file and matches the whole-file digest", async () => {
    const { blob, bytes } = await makeFile(300_000);
    const key = await keyFor(1);
    const channel = new FakeChannel();
    const sent = await sendFile({
      fileId: 1,
      file: blob,
      chunkSize: 65536,
      salt,
      key,
      channel,
    });
    expect(sent.chunkCount).toBe(5);
    expect(sent.sha256).toBe(sha256Hex(bytes));

    const receiver = new ChunkReceiver({
      fileId: 1,
      size: bytes.length,
      chunkSize: 65536,
      salt,
      key,
    });
    for (const raw of channel.frames)
      await receiver.handleFrame(decodeChunkFrame(raw));
    const result = receiver.finish();
    expect(result.complete).toBe(true);
    expect(result.sha256).toBe(sha256Hex(bytes));
    expect(receiver.received.size).toBe(5);
    expect(Array.from(receiver.collectBytes())).toEqual(Array.from(bytes));
  });

  it("handles a 1 MiB file with the maximum chunk size", async () => {
    const { blob, bytes } = await makeFile(1024 * 1024);
    const key = await keyFor(4);
    const channel = new FakeChannel();
    const sent = await sendFile({
      fileId: 4,
      file: blob,
      chunkSize: 262_144,
      salt,
      key,
      channel,
    });
    expect(sent.chunkSize).toBe(262_116);
    expect(sent.chunkCount).toBe(5);
    const receiver = new ChunkReceiver({
      fileId: 4,
      size: bytes.length,
      chunkSize: sent.chunkSize,
      salt,
      key,
    });
    for (const raw of channel.frames)
      await receiver.handleFrame(decodeChunkFrame(raw));
    expect(receiver.finish().sha256).toBe(sent.sha256);
  });

  it("accepts out-of-order frames and still hashes in file order", async () => {
    const { blob, bytes } = await makeFile(200_000);
    const key = await keyFor(2);
    const channel = new FakeChannel();
    const sent = await sendFile({
      fileId: 2,
      file: blob,
      chunkSize: 65536,
      salt,
      key,
      channel,
    });
    const receiver = new ChunkReceiver({
      fileId: 2,
      size: bytes.length,
      chunkSize: 65536,
      salt,
      key,
    });
    for (const raw of [...channel.frames].reverse())
      await receiver.handleFrame(decodeChunkFrame(raw));
    const result = receiver.finish();
    expect(result.complete).toBe(true);
    expect(result.sha256).toBe(sent.sha256);
  });

  it("ignores duplicate frames (resume retries) and reports missing chunks", async () => {
    const { blob, bytes } = await makeFile(300_000);
    const key = await keyFor(3);
    const channel = new FakeChannel();
    await sendFile({
      fileId: 3,
      file: blob,
      chunkSize: 65536,
      salt,
      key,
      channel,
    });
    const receiver = new ChunkReceiver({
      fileId: 3,
      size: bytes.length,
      chunkSize: 65536,
      salt,
      key,
    });
    await receiver.handleFrame(decodeChunkFrame(channel.frames[0]!));
    await receiver.handleFrame(decodeChunkFrame(channel.frames[0]!));
    await receiver.handleFrame(decodeChunkFrame(channel.frames[2]!));
    expect(receiver.received.size).toBe(2);
    expect(receiver.missingChunks()).toEqual([1, 3, 4]);
    expect(receiver.finish().complete).toBe(false);
  });

  it("rejects a chunk carrying the wrong file id or sequence", async () => {
    const { blob, bytes } = await makeFile(70_000);
    const key = await keyFor(5);
    const channel = new FakeChannel();
    await sendFile({
      fileId: 5,
      file: blob,
      chunkSize: 65536,
      salt,
      key,
      channel,
    });
    const receiver = new ChunkReceiver({
      fileId: 5,
      size: bytes.length,
      chunkSize: 65536,
      salt,
      key,
    });
    const frame = decodeChunkFrame(channel.frames[0]!);
    await expect(
      receiver.handleFrame({ ...frame, fileId: 6 }),
    ).rejects.toThrow();
    await expect(receiver.handleFrame({ ...frame, seq: 99 })).rejects.toThrow();
  });

  it("aborts when the signal is cancelled", async () => {
    const { blob } = await makeFile(300_000);
    const key = await keyFor(7);
    const channel = new FakeChannel();
    const controller = new AbortController();
    controller.abort();
    await expect(
      sendFile({
        fileId: 7,
        file: blob,
        chunkSize: 65536,
        salt,
        key,
        channel,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});

describe("receiver helpers", () => {
  it("collectBytes assembles chunks in arrival order", async () => {
    const { blob, bytes } = await makeFile(120_000);
    const key = await keyFor(6);
    const channel = new FakeChannel();
    await sendFile({
      fileId: 6,
      file: blob,
      chunkSize: 65536,
      salt,
      key,
      channel,
    });
    const receiver = new ChunkReceiver({
      fileId: 6,
      size: bytes.length,
      chunkSize: 65536,
      salt,
      key,
    });
    for (const raw of channel.frames)
      await receiver.handleFrame(decodeChunkFrame(raw));
    expect(Array.from(receiver.collectBytes())).toEqual(Array.from(bytes));
    expect(receiver.sawLastFrame).toBe(true);
    expect(receiver.bitmap()).not.toBe("");
  });
});

describe("bitmap", () => {
  it("round-trips received chunk sets", () => {
    const received = new Set([0, 2, 3, 8000 - 1].filter((n) => n >= 0));
    const encoded = encodeBitmap(received, 8000);
    expect(encoded.length).toBeGreaterThan(1330); // ceil(8000/8)=1000 bytes base64
    expect(encoded.length).toBeLessThan(1340);
    expect([...decodeBitmap(encoded, 8000)].sort((a, b) => a - b)).toEqual(
      [...received].sort((a, b) => a - b),
    );
  });

  it("tolerates trailing zero bytes", () => {
    expect([...decodeBitmap("AA==", 5)]).toEqual([]);
  });
});
