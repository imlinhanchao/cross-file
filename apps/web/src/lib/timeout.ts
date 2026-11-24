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
