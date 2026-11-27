import { describe, expect, it, vi } from "vitest";
import {
  PeerSession,
  type PeerSessionHooks,
  type QueuedJobView,
} from "./peer.js";
import { fakeCaps } from "./test-fakes.js";

function file(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name);
}

function hooks(overrides: Partial<PeerSessionHooks> = {}): PeerSessionHooks {
  return {
    selfIsAdmin: () => true,
    peerIsAdmin: () => false,
    offerer: () => true,
    relayOnly: false,
    caps: () => fakeCaps,
    peerName: () => "Dev B",
    sessionKey: () => new Uint8Array(32),
    hasKey: () => true,
    nativeShell: () => false,
    autoAccept: () => false,
    sendSignal: () => undefined,
    handleRoomCtrl: () => false,
    onOpen: () => undefined,
    onLost: () => undefined,
    onPath: () => undefined,
    incoming: () => undefined,
    incomingAccepted: () => undefined,
    incomingProgress: () => undefined,
    incomingFileDone: () => undefined,
    incomingFinished: () => undefined,
    incomingDeclined: () => undefined,
    incomingCancelled: () => undefined,
    outgoingStarted: () => undefined,
    outgoingProgress: () => undefined,
    outgoingPaused: () => undefined,
    outgoingFinished: () => undefined,
    queueChanged: () => undefined,
    failed: () => undefined,
    confirmIncoming: async () => true,
    nextTransferId: () => "dev-a:1",
    ...overrides,
  };
}

describe("PeerSession queued jobs", () => {
  it("lists waiting jobs with a stable per-pair job id", () => {
    const changes: QueuedJobView[][] = [];
    const session = new PeerSession(
      "dev-b",
      hooks({ queueChanged: (jobs) => changes.push(jobs) }),
    );
    session.enqueue([file("a.bin")]);
    session.enqueue([file("b.bin")]);
    const jobs = changes[changes.length - 1]!;
    expect(jobs.map((job) => job.files[0]?.name)).toEqual(["a.bin", "b.bin"]);
    expect(jobs[1]!.jobId).toBeGreaterThan(jobs[0]!.jobId);
    session.close();
  });

  it("cancels exactly one waiting job without touching the others", () => {
    const changes: QueuedJobView[][] = [];
    const session = new PeerSession(
      "dev-b",
      hooks({ queueChanged: (jobs) => changes.push(jobs) }),
    );
    session.enqueue([file("a.bin")]);
    session.enqueue([file("b.bin")]);
    const first = changes[changes.length - 1]![0]!.jobId;
    expect(session.cancelQueued(first)).toBe(true);
    expect(
      changes[changes.length - 1]!.map((job) => job.files[0]?.name),
    ).toEqual(["b.bin"]);
    // Removing the same job twice is a no-op, not an error.
    expect(session.cancelQueued(first)).toBe(false);
    session.close();
  });

  it("reports no active transfer when the pair is idle", () => {
    const session = new PeerSession("dev-b", hooks());
    expect(session.cancelActive()).toBe(false);
    expect(session.busy).toBe(false);
    session.close();
  });
});
