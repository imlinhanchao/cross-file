/**
 * Privacy-first logging (docs/02 §7).
 *
 * The signaling server must not keep access logs and must never log an IP, a user agent,
 * a room id or message payloads. Only error level output is allowed, and callers must pass
 * a *constant* scope string (never user data) plus a technical detail.
 */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Mask the first two segments of an address, so a log line can never identify a peer
 * (docs/02 §7: IPs stay in memory as rate-limit keys only). Kept for defensive logging.
 */
export function redactIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  if (IPV4.test(mapped)) {
    const parts = mapped.split(".");
    return `***.***.${parts[2] ?? "***"}.${parts[3] ?? "***"}`;
  }
  if (mapped.includes(":")) {
    const groups = mapped.split(":");
    const tail = groups.slice(-2).join(":");
    return `****:…:${tail}`;
  }
  return "***";
}

/**
 * The only logging entry point. `scope` must be a compile-time constant and `detail` must be
 * a technical error: never a request object, never an IP, never a room id.
 */
export function logError(scope: string, detail: unknown): void {
  const text = detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail);
  console.error(`[signaling] ${scope}: ${text}`);
}
