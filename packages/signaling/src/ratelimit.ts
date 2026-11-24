/**
 * Per-IP signaling rate limiter (docs/02 §6.7: "官方实例按 IP 限频（内存计数，不落盘）").
 *
 * In-memory only: the map is the single place an IP is ever kept, and it is dropped on stop
 * or when the window expires (docs/02 §7 "零存储").
 */

export interface RateLimitPolicy {
  windowMs: number;
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly policy: RateLimitPolicy;
  private readonly now: () => number;

  constructor(policy: RateLimitPolicy, now: () => number = () => Date.now()) {
    this.policy = policy;
    this.now = now;
  }

  /** Count one message; returns false when the caller must be rejected with RATE_LIMITED. */
  take(key: string): boolean {
    const at = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || at >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: at + this.policy.windowMs });
      return true;
    }
    if (bucket.count >= this.policy.max) return false;
    bucket.count += 1;
    return true;
  }

  /** Drop buckets whose window has passed (called from the room sweep). */
  sweep(): void {
    const at = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= at) this.buckets.delete(key);
    }
  }

  clear(): void {
    this.buckets.clear();
  }
}
