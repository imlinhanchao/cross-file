/**
 * Deployment configuration parsed from the environment (docs/self-host.md, docs/02 §1).
 *
 * `MAX_MEMBERS` is the room capacity **excluding the admin** (docs/01 D6): the official
 * instance uses 2, self-hosted deployments default to 4. `MAX_GUESTS` is accepted as a legacy
 * alias so existing `.env` files keep working; `MAX_MEMBERS` wins when both are present.
 *
 * Invalid values fail fast instead of silently falling back: a wrong room capacity is an
 * operational surprise, not something to hide.
 */
import { MAX_MEMBERS } from "@crossfile/core/protocol";

const KEYS = ["MAX_MEMBERS", "MAX_GUESTS"] as const;

/** Parse the member cap from an env-like record; `undefined` means "use MAX_MEMBERS". */
export function parseMaxMembers(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  for (const key of KEYS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new Error(
        `${key} must be a positive integer (got "${raw}"); unset it for the default (${MAX_MEMBERS})`,
      );
    }
    return Number(raw);
  }
  return undefined;
}
