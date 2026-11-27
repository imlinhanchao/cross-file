import { CTRL_HEARTBEAT_MS, CTRL_TIMEOUT_MS } from "@crossfile/core";

export interface TimeoutGuard {
  cancel(): void;
}

/** Small timer guard so call sites can cancel a pending timeout without bookkeeping. */
export function startTimeout(ms: number, onTimeout: () => void): TimeoutGuard {
  const timer = setTimeout(onTimeout, ms);
  return { cancel: () => clearTimeout(timer) };
}

/**
 * docs/02 §4.5: the 4-emoji SAS must be confirmed within 60 s, otherwise the
 * pairing is abandoned. A dev-only query override keeps the e2e suite fast.
 */
export function sasTimeoutMs(): number {
  if (import.meta.env.DEV) {
    const raw = new URLSearchParams(location.search).get("sasTimeoutMs");
    const override = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(override) && override > 0) return override;
  }
  return 60_000;
}

/** DEV-ONLY numeric query parameter helper; disabled in production builds. */
function devQueryMs(name: string): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  const raw = new URLSearchParams(location.search).get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Per-pair ctrl heartbeat timing (docs/02 §10.2 implementation note). The
 * defaults are the protocol constants; a dev-only `?ctrlHeartbeatMs=` /
 * `?ctrlTimeoutMs=` shortens them for local diagnosis and the e2e suite, using
 * the same escape hatch shape as `?sasTimeoutMs=`.
 */
export function ctrlHeartbeatMs(): number {
  return devQueryMs("ctrlHeartbeatMs") ?? CTRL_HEARTBEAT_MS;
}

export function ctrlTimeoutMs(): number {
  return devQueryMs("ctrlTimeoutMs") ?? CTRL_TIMEOUT_MS;
}
