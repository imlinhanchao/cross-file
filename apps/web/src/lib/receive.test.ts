import { describe, expect, it, vi } from "vitest";
import { base64Encode, type Manifest } from "@crossfile/core";
import type { Mock } from "vitest";
import { ReceiverTransfer, type ReceiverCallbacks } from "./receive.js";
import {
  ctrlTypes,
  fakeCaps,
  fakeHandles,
  waitFor,
  withTimeout,
} from "./test-fakes.js";

const TRANSFER_ID = "dev-b:2";

function manifestFor(size = 4): Manifest {
  return {
    v: 2,
    type: "manifest",
    transferId: TRANSFER_ID,
    files: [
      {
        id: 1,
        name: "b.bin",
        size,
        mime: "application/octet-stream",
        chunk: 65_536,
        chunkCount: 1,
        salt: base64Encode(new Uint8Array(4)),
      },
    ],
    totalSize: size,
    chunkNegotiation: { min: 65_536, max: 262_144 },
  };
}

function callbacks() {
  const cb: ReceiverCallbacks = {
    incoming: vi.fn(),
    accepted: vi.fn(),
    progress: vi.fn(),
    fileDone: vi.fn(),
    finished: vi.fn(),
    declined: vi.fn(),
    cancelled: vi.fn(),
    failed: vi.fn(),
  };
  // Keep the mock handles visible to the assertions (the interface only promises functions).
  return cb as ReceiverCallbacks & Record<keyof ReceiverCallbacks, Mock>;
}

function setup(
  options: { autoAccept?: boolean; confirm?: () => Promise<boolean> } = {},
): {
  receiver: ReceiverTransfer;
  fakes: ReturnType<typeof fakeHandles>;
  cb: ReturnType<typeof callbacks>;
  start: Promise<void>;
} {
  const fakes = fakeHandles();
  const cb = callbacks();
  const receiver = new ReceiverTransfer({
    transferId: TRANSFER_ID,
    manifest: manifestFor(),
    peerId: "dev-a",
    peerName: "Dev A",
    caps: fakeCaps,
    sessionKey: new Uint8Array(32),
    getHandles: () => fakes.handles,
    whenOpen: async () => fakes.handles,
    confirm: options.confirm ?? (async () => true),
    autoAccept: () => options.autoAccept ?? true,
    isNativeShell: false,
    callbacks: cb,
  });
  return { receiver, fakes, cb, start: receiver.start() };
}

describe("ReceiverTransfer cancel", () => {
  it("a local cancel tells the sender and stops receiving", async () => {
    const { receiver, fakes, cb, start } = setup();
    await waitFor(() => cb.accepted.mock.calls.length > 0, 3_000, "accepted");
    receiver.cancel("local");
    await withTimeout(start);
    expect(cb.cancelled).toHaveBeenCalledWith("local");
    const cancel = fakes.ctrlSent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((message) => message.type === "cancel");
    expect(cancel).toMatchObject({ transferId: TRANSFER_ID, reason: "user" });
    // Dropped buffers: a frame arriving after the cancel is ignored.
    await expect(
      receiver.handleFrame({
        fileId: 1,
        seq: 0,
        last: true,
        ciphertext: new Uint8Array(16),
      }),
    ).resolves.toBeUndefined();
  });

  it("a peer cancel is never echoed back", async () => {
    const { receiver, fakes, cb, start } = setup();
    await waitFor(() => cb.accepted.mock.calls.length > 0, 3_000, "accepted");
    receiver.cancel("peer");
    expect(cb.cancelled).toHaveBeenCalledWith("peer");
    expect(ctrlTypes(fakes.ctrlSent)).not.toContain("cancel");
  });

  it("a cancel while the consent card is up sends no accept and no cancel", async () => {
    let grant: ((value: boolean) => void) | undefined;
    const confirm = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        grant = resolve;
      });
    const { receiver, fakes, cb, start } = setup({
      autoAccept: false,
      confirm,
    });
    await waitFor(() => cb.incoming.mock.calls.length > 0, 3_000, "consent");
    receiver.cancel("peer");
    grant?.(true);
    await withTimeout(start);
    expect(cb.cancelled).toHaveBeenCalledWith("peer");
    expect(ctrlTypes(fakes.ctrlSent)).toEqual([]);
  });
});
