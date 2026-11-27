import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CtrlHeartbeat } from "./heartbeat.js";

/** Deterministic clock + vitest fake timers: no browser, no wall clock. */
function setup(options: { heartbeatMs?: number; timeoutMs?: number } = {}): {
  heartbeat: CtrlHeartbeat;
  pings: () => number;
  timeouts: () => number;
  advance(ms: number): void;
  clock: { t: number };
} {
  const clock = { t: 0 };
  let pings = 0;
  let timeouts = 0;
  const heartbeat = new CtrlHeartbeat({
    heartbeatMs: options.heartbeatMs ?? 3_000,
    timeoutMs: options.timeoutMs ?? 10_000,
    now: () => clock.t,
    sendPing: () => {
      pings += 1;
    },
    onTimeout: () => {
      timeouts += 1;
    },
  });
  return {
    heartbeat,
    pings: () => pings,
    timeouts: () => timeouts,
    clock,
    advance: (ms: number) => {
      clock.t += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

describe("CtrlHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings every heartbeat interval while the pair is open", () => {
    const h = setup();
    h.heartbeat.start();
    h.advance(3_000);
    expect(h.pings()).toBe(1);
    h.advance(6_000);
    expect(h.pings()).toBe(3);
    h.heartbeat.stop();
  });

  it("does not declare a timeout while the peer keeps ponging", () => {
    const h = setup();
    h.heartbeat.start();
    for (let i = 0; i < 5; i += 1) {
      h.advance(3_000);
      h.heartbeat.notePong();
    }
    expect(h.timeouts()).toBe(0);
    expect(h.heartbeat.active).toBe(true);
    h.heartbeat.stop();
  });

  it("declares the pair lost ~10 s after the last frame", () => {
    const h = setup();
    h.heartbeat.start();
    h.heartbeat.notePong(); // peer speaks heartbeat
    h.advance(9_000);
    expect(h.timeouts()).toBe(0);
    h.advance(1_000);
    expect(h.timeouts()).toBe(1);
    // The heartbeat stops itself; no further timeouts are reported.
    h.advance(30_000);
    expect(h.timeouts()).toBe(1);
    expect(h.heartbeat.active).toBe(false);
  });

  it("any frame (not only a pong) counts as activity", () => {
    const h = setup();
    h.heartbeat.start();
    h.heartbeat.notePong();
    h.advance(8_000);
    h.heartbeat.noteActivity(); // e.g. a data frame or a ctrl message
    h.advance(9_000);
    expect(h.timeouts()).toBe(0);
    h.advance(1_000);
    expect(h.timeouts()).toBe(1);
  });

  it("never times out a peer that does not answer pings (older page)", () => {
    const h = setup();
    h.heartbeat.start();
    h.advance(60_000);
    expect(h.timeouts()).toBe(0);
    expect(h.heartbeat.peerSpeaksHeartbeat).toBe(false);
    h.heartbeat.stop();
  });

  it("stop clears both timers and start can run again for a rebuilt pair", () => {
    const h = setup();
    h.heartbeat.start();
    h.heartbeat.stop();
    h.advance(30_000);
    expect(h.pings()).toBe(0);
    expect(h.timeouts()).toBe(0);
    h.heartbeat.start();
    h.advance(3_000);
    expect(h.pings()).toBe(1);
    h.heartbeat.stop();
  });
});
