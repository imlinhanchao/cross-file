/** Capability detection + per-receiver size limits (docs/01 §6, docs/02 §5). */
import type { Caps, Platform, SaveStrategy, UAFamily } from "./protocol.js";

export interface CapsSource {
  userAgent?: string;
  maxTouchPoints?: number;
  screenWidth?: number;
  screenHeight?: number;
  secureContext?: boolean;
  hasFsPicker?: boolean;
  hasServiceWorker?: boolean;
  /** set once the self-hosted service-worker download path proved itself at runtime */
  swDownload?: boolean;
  nativeShell?: boolean;
  deviceMemoryGB?: number;
  storageQuotaMB?: number;
}

export function uaFamilyOf(ua: string): UAFamily {
  // ArkWeb UAs also contain "Chrome/…"; must be checked first (附录 C B1b).
  if (/ArkWeb\//i.test(ua)) return "arkweb";
  if (/Edg\//i.test(ua)) return "edge";
  if (/Firefox\//i.test(ua)) return "firefox";
  if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) return "chrome";
  if (/Safari\//i.test(ua)) return "safari";
  return "unknown";
}

export function platformOf(ua: string, uaFamily: UAFamily, maxTouchPoints = 0): Platform {
  if (/HarmonyOS|OpenHarmony/i.test(ua)) return "harmony";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  // iPadOS 13+ reports a macOS UA but has touch points.
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "win";
  if (/Linux|X11/i.test(ua) && uaFamily !== "unknown") return "linux";
  return uaFamily === "unknown" ? "unknown" : "linux";
}

function defaultSource(): CapsSource {
  const nav = globalThis.navigator as Navigator | undefined;
  const win = globalThis as unknown as {
    showSaveFilePicker?: unknown;
    __CROSSFILE_NATIVE__?: boolean;
    screen?: { width: number; height: number };
  };
  const ua = nav?.userAgent ?? "";
  const maxTouchPoints = nav?.maxTouchPoints ?? 0;
  const width = win.screen?.width ?? 1280;
  const secureContext =
    typeof (globalThis as { isSecureContext?: boolean }).isSecureContext === "boolean"
      ? (globalThis as { isSecureContext?: boolean }).isSecureContext!
      : false;
  return {
    userAgent: ua,
    maxTouchPoints,
    screenWidth: width,
    screenHeight: win.screen?.height ?? 800,
    secureContext,
    hasFsPicker: typeof win.showSaveFilePicker === "function",
    hasServiceWorker: typeof nav !== "undefined" && "serviceWorker" in nav,
    swDownload: false,
    nativeShell: win.__CROSSFILE_NATIVE__ === true,
    deviceMemoryGB: (nav as { deviceMemory?: number } | undefined)?.deviceMemory,
  };
}

export function detectCaps(source: CapsSource = defaultSource()): Caps {
  const ua = source.userAgent ?? "";
  const family = uaFamilyOf(ua);
  const platform = platformOf(ua, family, source.maxTouchPoints ?? 0);
  const secureContext = source.secureContext ?? false;
  const nativeShell = source.nativeShell === true;
  const fsAccess = !nativeShell && (source.hasFsPicker ?? false);
  const sw = (source.hasServiceWorker ?? false) && secureContext;
  // The SW download path is self-built and only advertised once probed (M2).
  const swDownload = !nativeShell && sw && (source.swDownload ?? false);

  const strategies: SaveStrategy[] = [];
  if (nativeShell) strategies.push("native");
  if (fsAccess) strategies.push("fs");
  if (swDownload) strategies.push("sw");
  strategies.push("blob");

  const width = source.screenWidth ?? 1280;
  const touch = (source.maxTouchPoints ?? 0) > 0;
  const screen: Caps["screen"] = touch ? (width >= 768 ? "tablet" : "phone") : "desktop";

  const caps: Caps = {
    platform,
    uaFamily: family,
    nativeShell,
    secureContext,
    fsAccess,
    sw,
    swDownload,
    saveStrategies: strategies,
    screen,
  };
  if (source.deviceMemoryGB !== undefined) caps.deviceMemoryGB = source.deviceMemoryGB;
  if (source.storageQuotaMB !== undefined) caps.storageQuotaMB = source.storageQuotaMB;
  return caps;
}

const MB = 1024 * 1024;

export interface LimitRule {
  softLimitMB: number;
  hardLimitMB: number;
  reason: "native" | "fs" | "ios" | "android" | "safari" | "firefox" | "unknown";
  /** i18n key, rendered by packages/ui/src/copy.ts */
  messageKey: string;
}

/**
 * docs/02 §5 numbered rules, corrected where they contradict docs/01 §6's table:
 * iOS must be checked before "safari" (an iPhone is always Safari/WebKit).
 */
export function limitsFor(caps: Caps): LimitRule {
  if (caps.nativeShell) {
    return { softLimitMB: 500, hardLimitMB: 500, reason: "native", messageKey: "limit.native" };
  }
  if (caps.fsAccess && (caps.uaFamily === "chrome" || caps.uaFamily === "edge")) {
    return { softLimitMB: 500, hardLimitMB: 500, reason: "fs", messageKey: "limit.fs" };
  }
  if (caps.platform === "ios") {
    return { softLimitMB: 100, hardLimitMB: 500, reason: "ios", messageKey: "limit.ios" };
  }
  if (caps.platform === "android") {
    return { softLimitMB: 150, hardLimitMB: 500, reason: "android", messageKey: "limit.android" };
  }
  if (caps.uaFamily === "safari") {
    return { softLimitMB: 250, hardLimitMB: 500, reason: "safari", messageKey: "limit.safari" };
  }
  if (caps.uaFamily === "firefox") {
    return { softLimitMB: 250, hardLimitMB: 500, reason: "firefox", messageKey: "limit.firefox" };
  }
  return { softLimitMB: 150, hardLimitMB: 500, reason: "unknown", messageKey: "limit.unknown" };
}

export type LimitLevel = "ok" | "warn" | "reject";

export interface LimitVerdict {
  level: LimitLevel;
  softLimitMB: number;
  hardLimitMB: number;
  rule: LimitRule;
}

export function judgeFile(sizeBytes: number, caps: Caps): LimitVerdict {
  const rule = limitsFor(caps);
  const sizeMB = sizeBytes / MB;
  const level: LimitLevel = sizeMB > rule.hardLimitMB ? "reject" : sizeMB > rule.softLimitMB ? "warn" : "ok";
  return { level, softLimitMB: rule.softLimitMB, hardLimitMB: rule.hardLimitMB, rule };
}

export function severityOrder(level: LimitLevel): number {
  return level === "reject" ? 2 : level === "warn" ? 1 : 0;
}
