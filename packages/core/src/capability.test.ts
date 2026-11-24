import { describe, expect, it } from "vitest";
import {
  detectCaps,
  judgeFile,
  limitsFor,
  platformOf,
  uaFamilyOf,
} from "./capability.js";

const UA = {
  chromeDesktop:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  safariDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36",
  firefoxDesktop:
    "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0",
  arkWeb:
    "Mozilla/5.0 (Phone; OpenHarmony 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile",
  harmonyBrowser:
    "Mozilla/5.0 (Phone; HarmonyOS 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
};

const MB = 1024 * 1024;

describe("UA family / platform detection", () => {
  it("identifies ArkWeb before Chrome", () => {
    expect(uaFamilyOf(UA.arkWeb)).toBe("arkweb");
    expect(uaFamilyOf(UA.chromeDesktop)).toBe("chrome");
    expect(uaFamilyOf(UA.iphoneSafari)).toBe("safari");
    expect(uaFamilyOf(UA.firefoxDesktop)).toBe("firefox");
  });

  it("maps platforms", () => {
    expect(platformOf(UA.iphoneSafari, "safari", 5)).toBe("ios");
    expect(platformOf(UA.androidChrome, "chrome", 5)).toBe("android");
    expect(platformOf(UA.arkWeb, "arkweb", 5)).toBe("harmony");
    expect(platformOf(UA.safariDesktop, "safari", 0)).toBe("mac");
    expect(platformOf(UA.chromeDesktop, "chrome", 0)).toBe("linux");
  });

  it("treats an iPad masquerading as macOS as iOS", () => {
    const ipadUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";
    expect(platformOf(ipadUa, "safari", 5)).toBe("ios");
  });
});

describe("limits table (docs/01 §6)", () => {
  it("native shell gets 500/500", () => {
    const caps = detectCaps({
      userAgent: UA.chromeDesktop,
      nativeShell: true,
      secureContext: true,
    });
    expect(limitsFor(caps)).toMatchObject({
      softLimitMB: 500,
      hardLimitMB: 500,
      reason: "native",
    });
  });

  it("Chromium desktop with the file system API gets 500/500", () => {
    const caps = detectCaps({
      userAgent: UA.chromeDesktop,
      hasFsPicker: true,
      secureContext: true,
      hasServiceWorker: true,
    });
    expect(limitsFor(caps)).toMatchObject({
      softLimitMB: 500,
      hardLimitMB: 500,
      reason: "fs",
    });
  });

  it("iPhone Safari is 100/500 even though Safari desktop is 250", () => {
    const iphone = detectCaps({
      userAgent: UA.iphoneSafari,
      maxTouchPoints: 5,
      screenWidth: 390,
      secureContext: true,
      hasServiceWorker: true,
    });
    expect(limitsFor(iphone)).toMatchObject({
      softLimitMB: 100,
      hardLimitMB: 500,
      reason: "ios",
    });

    const macSafari = detectCaps({
      userAgent: UA.safariDesktop,
      maxTouchPoints: 0,
      secureContext: true,
      hasServiceWorker: true,
    });
    expect(limitsFor(macSafari)).toMatchObject({
      softLimitMB: 250,
      hardLimitMB: 500,
      reason: "safari",
    });
  });

  it("Android browser is 150/500 and Firefox desktop 250/500", () => {
    const android = detectCaps({
      userAgent: UA.androidChrome,
      maxTouchPoints: 5,
      screenWidth: 412,
      secureContext: true,
      hasServiceWorker: true,
    });
    expect(limitsFor(android).reason).toBe("android");
    const firefox = detectCaps({
      userAgent: UA.firefoxDesktop,
      secureContext: true,
      hasServiceWorker: true,
    });
    expect(limitsFor(firefox).reason).toBe("firefox");
  });

  it("unknown receivers fall back to 150/500", () => {
    const caps = detectCaps({ userAgent: "curl/8.0", secureContext: true });
    expect(limitsFor(caps)).toMatchObject({
      softLimitMB: 150,
      hardLimitMB: 500,
      reason: "unknown",
    });
  });
});

describe("detectCaps defaults", () => {
  it("detectCaps() works with no arguments in a bare Node process", () => {
    const caps = detectCaps();
    expect(caps.saveStrategies).toContain("blob");
    expect(typeof caps.secureContext).toBe("boolean");
  });

  it("falls back safely when no browser globals are available", () => {
    const caps = detectCaps({});
    expect(caps.uaFamily).toBe("unknown");
    expect(caps.secureContext).toBe(false);
    expect(caps.saveStrategies).toEqual(["blob"]);
    expect(caps.screen).toBe("desktop");
  });

  it("marks a touch device with a narrow screen as phone", () => {
    const caps = detectCaps({
      userAgent: UA.androidChrome,
      maxTouchPoints: 5,
      screenWidth: 390,
    });
    expect(caps.screen).toBe("phone");
  });
});

describe("judgeFile", () => {
  const iphone = detectCaps({
    userAgent: UA.iphoneSafari,
    maxTouchPoints: 5,
    screenWidth: 390,
    secureContext: true,
    hasServiceWorker: true,
  });

  it("passes small files", () => {
    expect(judgeFile(50 * MB, iphone).level).toBe("ok");
  });

  it("warns between the soft and hard limits", () => {
    expect(judgeFile(300 * MB, iphone).level).toBe("warn");
  });

  it("rejects above the hard limit", () => {
    expect(judgeFile(501 * MB, iphone).level).toBe("reject");
  });

  it("treats exactly-soft-limit as ok and exactly-hard as warn", () => {
    expect(judgeFile(100 * MB, iphone).level).toBe("ok");
    expect(judgeFile(500 * MB, iphone).level).toBe("warn");
  });

  it("records fs capability and save strategy ordering", () => {
    const chrome = detectCaps({
      userAgent: UA.chromeDesktop,
      hasFsPicker: true,
      secureContext: true,
      hasServiceWorker: true,
    });
    expect(chrome.saveStrategies).toEqual(["fs", "blob"]);
  });

  it("advertises the service worker strategy only once swDownload is probed true", () => {
    const safari = detectCaps({
      userAgent: UA.safariDesktop,
      secureContext: true,
      hasServiceWorker: true,
      swDownload: true,
    });
    expect(safari.saveStrategies).toEqual(["sw", "blob"]);
  });
});
