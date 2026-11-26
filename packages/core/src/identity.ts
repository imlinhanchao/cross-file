/**
 * Display-name helpers (ADR 0010 §names).
 *
 * A display name is a device-local, non-identifying label: the signaling server
 * only relays it, nothing is stored server side, and the user may change it at
 * any time. A valid name is 1-16 Unicode code points after trimming and dropping
 * control characters.
 */
import type { Caps, Platform } from "./protocol.js";

const PLATFORM_LABELS: Record<Platform, string> = {
  win: "Windows",
  mac: "MacBook",
  linux: "电脑",
  ios: "iPhone",
  android: "手机",
  harmony: "鸿蒙",
  unknown: "设备",
};

/** Base32 (RFC 4648) without padding, uppercase: 32 symbols, so `byte & 31` is unbiased. */
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH = 4;
const MAX_NAME_CODE_POINTS = 16;
const FALLBACK_NAME = "设备";
const CONTROL_CHARS = /[\p{Cc}]/gu;

/** Human label for a platform, e.g. `mac` -> `MacBook`. */
export function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS[platform] ?? PLATFORM_LABELS.unknown;
}

/**
 * Default name for a device, e.g. `MacBook · 7K2F`. Uniqueness inside a room is
 * not guaranteed here; {@link dedupeNames} adds `-2`, `-3`, … on collision.
 */
export function defaultDisplayName(caps: Caps): string {
  return `${platformLabel(caps.platform)} · ${randomCode(CODE_LENGTH)}`;
}

/**
 * Trim, drop control characters and enforce 1-16 Unicode code points.
 * Returns null when the result is empty or too long (caller should re-prompt
 * rather than silently truncate what the user typed).
 */
export function normalizeDisplayName(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length === 0) return null;
  if ([...cleaned].length > MAX_NAME_CODE_POINTS) return null;
  return cleaned;
}

/**
 * Make a list of candidate names unique in join order, case-sensitively:
 * `["iPhone · AB12", "iPhone · AB12"]` -> `["iPhone · AB12", "iPhone · AB12-2"]`.
 * Invalid candidates fall back to `设备`. Suffixed names stay within 16 code points.
 */
export function dedupeNames(baseNames: string[]): string[] {
  const used = new Set<string>();
  const result: string[] = [];
  for (const raw of baseNames) {
    const base = normalizeDisplayName(raw) ?? FALLBACK_NAME;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = withSuffix(base, `-${suffix}`);
      suffix += 1;
    }
    used.add(candidate);
    result.push(candidate);
  }
  return result;
}

function withSuffix(base: string, suffix: string): string {
  const room = MAX_NAME_CODE_POINTS - [...suffix].length;
  const truncated = [...base].slice(0, Math.max(1, room)).join("").trimEnd();
  return `${truncated || FALLBACK_NAME}${suffix}`;
}

function randomCode(length: number): string {
  const bytes = new Uint8Array(length);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    // Non-secure fallback for runtimes without WebCrypto; a display code is not a secret.
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
  return code;
}
