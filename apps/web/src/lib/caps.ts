import { detectCaps, type Caps } from "@crossfile/core";

/**
 * Capability pack sent with hello/join/create (docs/02 §5, D16).
 *
 * Besides the sync UA/platform probe we ask the browser for the origin's storage
 * quota so the peer can refuse a file it could never hold (see judgeFile).
 */
export async function probeCaps(): Promise<Caps> {
  const caps = detectCaps();
  // Phase 2 (docs/02 §5/§11.1): this build can elect a pair offerer and mesh any
  // member with any member, so peers know they may use the lexicographic rule.
  caps.mesh = true;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && estimate.quota > 0) {
      caps.storageQuotaMB = Math.round(estimate.quota / (1024 * 1024));
    }
  } catch {
    // StorageManager is optional and may reject in private mode; caps stay conservative.
  }
  return caps;
}
