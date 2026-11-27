import { describe, expect, it, vi } from "vitest";
import { SenderTransfer, type SenderOutcome } from "./send.js";
import { ctrlTypes, fakeHandles, waitFor, withTimeout } from "./test-fakes.js";

const TRANSFER_ID = "dev-a:1";

function setup(bytes = 1_000): {
  transfer: SenderTransfer;
  fakes: ReturnType<typeof fakeHandles>;
  started: ReturnType<typeof vi.fn>;
} {
  const fakes = fakeHandles();
  const started = vi.fn();
  const transfer = new SenderTransfer({
    transferId: TRANSFER_ID,
    files: [new File([new Uint8Array(bytes)], "a.bin")],
    sessionKey: new Uint8Array(32),
    getHandles: () => fakes.handles,
    callbacks: {
      started,
      progress: vi.fn(),
      paused: vi.fn(),
    },
  });
  return { transfer, fakes, started };
}

async function expectCancelled(
  run: Promise<SenderOutcome>,
  by: "local" | "peer" | "yield",
): Promise<void> {
  await expect(withTimeout(run)).resolves.toEqual({
    ok: false,
    cancelled: true,
    by,
  });
}

describe("SenderTransfer cancel", () => {
  it("ends a local cancel before the manifest is accepted", async () => {
    const { transfer, fakes } = setup();
    const run = transfer.run();
    await waitFor(() => ctrlTypes(fakes.ctrlSent).includes("manifest"));
    transfer.cancel("local");
    await expectCancelled(run, "local");
    // Nothing of the cancelled job ever reaches the data channel.
    expect(fakes.dataSent).toHaveLength(0);
  });

  it("records a peer cancel separately from a user cancel", async () => {
    const { transfer, fakes } = setup();
    const run = transfer.run();
    await waitFor(() => ctrlTypes(fakes.ctrlSent).includes("manifest"));
    transfer.cancel("peer");
    await expectCancelled(run, "peer");
  });

  it("reports a priority yield so the caller can keep the job queued", async () => {
    const { transfer, fakes } = setup();
    const run = transfer.run();
    await waitFor(() => ctrlTypes(fakes.ctrlSent).includes("manifest"));
    transfer.cancel("yield");
    await expectCancelled(run, "yield");
  });

  it("keeps the first cancel source (a later close cannot rewrite it)", async () => {
    const { transfer, fakes } = setup();
    const run = transfer.run();
    await waitFor(() => ctrlTypes(fakes.ctrlSent).includes("manifest"));
    transfer.cancel("peer");
    transfer.cancel("local");
    await expectCancelled(run, "peer");
  });

  it("wakes a sender waiting for the final ack instead of the 120 s timeout", async () => {
    const { transfer, fakes } = setup();
    const run = transfer.run();
    await waitFor(() => ctrlTypes(fakes.ctrlSent).includes("manifest"));
    transfer.onCtrl({
      v: 2,
      type: "accept",
      transferId: TRANSFER_ID,
      fileIds: [1],
    });
    await waitFor(() => ctrlTypes(fakes.ctrlSent).includes("done"));
    transfer.cancel("local");
    await expectCancelled(run, "local");
    // The single chunk of this fixture was already sent before the cancel; the
    // point is that the machine unwinds immediately rather than at the timeout.
    expect(fakes.dataSent.length).toBe(1);
  });
});
