/**
 * Per-pair ctrl heartbeat (docs/02 §10.2 implementation note, v0.4.0).
 *
 * The `ctrl` data channel carries a channel-level `ping` every
 * {@link CTRL_HEARTBEAT_MS}; the peer answers `pong`, and *any* frame received on
 * the pair counts as activity. The timeout is armed as soon as the heartbeat
 * starts: when nothing at all arrives for {@link CTRL_TIMEOUT_MS} the pair is
 * declared lost and the normal "pair lost → offerer rebuilds" path runs
 * (docs/02 §6.5). This detects a frozen page / dead NAT binding in ~10 s instead
 * of waiting 5–30 s for a WebRTC close event, and a peer that never answers
 * (including one that never sends anything) is treated as broken and rebuilt.
 *
 * All inputs (clock, timers, ping send, timeout callback) are injected so the
 * decision logic is unit-tested without a browser or fake WebRTC.
 */
import { CTRL_HEARTBEAT_MS, CTRL_TIMEOUT_MS } from "@crossfile/core";

/** How often the timeout is evaluated; pings still go out at `heartbeatMs`. */
const CHECK_MS = 1_000;

type TimerHandle = ReturnType<typeof setInterval>;

export interface CtrlHeartbeatOptions {
  /** send `{v:2,type:"ping"}` on the pair's ctrl channel */
  sendPing(): void;
  /** ~10 s without any frame from the peer: rebuild the pair */
  onTimeout(): void;
  heartbeatMs?: number;
  timeoutMs?: number;
  now?: () => number;
  setIntervalFn?: (handler: () => void, ms: number) => TimerHandle;
  clearIntervalFn?: (handle: TimerHandle) => void;
}

export class CtrlHeartbeat {
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (
    handler: () => void,
    ms: number,
  ) => TimerHandle;
  private readonly clearIntervalFn: (handle: TimerHandle) => void;
  private readonly sendPing: () => void;
  private readonly onTimeout: () => void;
  private pingTimer?: TimerHandle;
  private checkTimer?: TimerHandle;
  private running = false;
  private lastActivityAt = 0;

  constructor(options: CtrlHeartbeatOptions) {
    this.sendPing = options.sendPing;
    this.onTimeout = options.onTimeout;
    this.heartbeatMs = options.heartbeatMs ?? CTRL_HEARTBEAT_MS;
    this.timeoutMs = options.timeoutMs ?? CTRL_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn =
      options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ?? ((handle) => clearInterval(handle));
  }

  get active(): boolean {
    return this.running;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /** Start after the pair opened; idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastActivityAt = this.now();
    this.pingTimer = this.setIntervalFn(
      () => this.sendPing(),
      this.heartbeatMs,
    );
    this.checkTimer = this.setIntervalFn(
      () => this.check(),
      Math.max(1, Math.min(this.heartbeatMs, CHECK_MS)),
    );
  }

  /** Stop when the pair closes/drops or the session is disposed; idempotent. */
  stop(): void {
    this.running = false;
    if (this.pingTimer !== undefined) {
      this.clearIntervalFn(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.checkTimer !== undefined) {
      this.clearIntervalFn(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  /** Any frame received from the peer (ctrl or data) keeps the pair alive. */
  noteActivity(): void {
    if (this.running) this.lastActivityAt = this.now();
  }

  private check(): void {
    if (!this.running) return;
    if (this.now() - this.lastActivityAt < this.timeoutMs) return;
    this.stop();
    this.onTimeout();
  }
}
