import { describe, expect, it } from "vitest";
import type { Caps, Platform } from "./protocol.js";
import {
  defaultDisplayName,
  dedupeNames,
  normalizeDisplayName,
  platformLabel,
} from "./identity.js";

function capsStub(platform: Platform): Caps {
  return {
    platform,
    uaFamily: "chrome",
    nativeShell: false,
    secureContext: true,
    fsAccess: true,
    sw: true,
    swDownload: false,
    saveStrategies: ["fs", "blob"],
    screen: "desktop",
  };
}

const CODE = /^[A-Z2-7]{4}$/;

describe("platformLabel", () => {
  it("maps every documented platform to a human label", () => {
    expect(platformLabel("win")).toBe("Windows");
    expect(platformLabel("mac")).toBe("MacBook");
    expect(platformLabel("linux")).toBe("电脑");
    expect(platformLabel("ios")).toBe("iPhone");
    expect(platformLabel("android")).toBe("手机");
    expect(platformLabel("harmony")).toBe("鸿蒙");
    expect(platformLabel("unknown")).toBe("设备");
  });
});

describe("defaultDisplayName", () => {
  it("is the platform label plus a 4 symbol base32 code", () => {
    for (const platform of [
      "win",
      "mac",
      "linux",
      "ios",
      "android",
      "harmony",
      "unknown",
    ] as const) {
      const name = defaultDisplayName(capsStub(platform));
      expect(name.startsWith(`${platformLabel(platform)} · `)).toBe(true);
      expect(name.slice(platformLabel(platform).length + 3)).toMatch(CODE);
    }
  });

  it("is always a valid display name", () => {
    for (let index = 0; index < 32; index += 1) {
      const name = defaultDisplayName(capsStub("mac"));
      expect(normalizeDisplayName(name)).toBe(name);
    }
  });

  it("produces a varying code instead of a constant", () => {
    const names = new Set(
      Array.from({ length: 32 }, () => defaultDisplayName(capsStub("linux"))),
    );
    expect(names.size).toBeGreaterThan(30);
  });
});

describe("normalizeDisplayName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeDisplayName("  MacBook · 7K2F  ")).toBe("MacBook · 7K2F");
  });

  it("drops control characters instead of rejecting the name", () => {
    expect(normalizeDisplayName("a\u0000b\nc\td")).toBe("abcd");
    expect(normalizeDisplayName("\u0007\u0008")).toBeNull();
    expect(normalizeDisplayName("Mac\u009fBook")).toBe("MacBook");
  });

  it("rejects empty and whitespace-only names", () => {
    expect(normalizeDisplayName("")).toBeNull();
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(normalizeDisplayName("\n\t")).toBeNull();
  });

  it("accepts 16 code points and rejects 17", () => {
    expect(normalizeDisplayName("a".repeat(16))).toBe("a".repeat(16));
    expect(normalizeDisplayName("a".repeat(17))).toBeNull();
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    const emoji16 = "😀".repeat(16);
    expect(emoji16.length).toBe(32); // two UTF-16 units per code point
    expect(normalizeDisplayName(emoji16)).toBe(emoji16);
    expect(normalizeDisplayName("😀".repeat(17))).toBeNull();
  });

  it("accepts Chinese and mixed names", () => {
    expect(normalizeDisplayName("华为手机")).toBe("华为手机");
    expect(normalizeDisplayName("我的 MacBook 13")).toBe("我的 MacBook 13");
  });
});

describe("dedupeNames", () => {
  it("leaves distinct names untouched", () => {
    expect(dedupeNames(["iPhone · AB12", "MacBook · CD34"])).toEqual([
      "iPhone · AB12",
      "MacBook · CD34",
    ]);
  });

  it("appends -2, -3, … to duplicates in join order", () => {
    expect(
      dedupeNames(["MacBook · 7K2F", "MacBook · 7K2F", "MacBook · 7K2F"]),
    ).toEqual(["MacBook · 7K2F", "MacBook · 7K2F-2", "MacBook · 7K2F-3"]);
  });

  it("compares case-sensitively", () => {
    expect(dedupeNames(["Name", "name"])).toEqual(["Name", "name"]);
  });

  it("falls back to 设备 for invalid candidates", () => {
    expect(dedupeNames(["", "   ", "\u0007"])).toEqual([
      "设备",
      "设备-2",
      "设备-3",
    ]);
  });

  it("trims and normalises every candidate", () => {
    expect(dedupeNames(["  A  ", "A\n"])).toEqual(["A", "A-2"]);
  });

  it("keeps suffixed names within 16 code points", () => {
    const long = "a".repeat(16);
    const [first, second] = dedupeNames([long, long]);
    expect(first).toBe(long);
    expect(second).toBe(`${"a".repeat(14)}-2`);
    expect([...second!].length).toBe(16);
  });

  it("keeps generating unique names when a suffixed name is taken", () => {
    expect(dedupeNames(["X", "X", "X-2"])).toEqual(["X", "X-2", "X-2-2"]);
  });

  it("never emits a duplicate", () => {
    const names = dedupeNames(Array.from({ length: 50 }, () => "设备"));
    expect(new Set(names).size).toBe(50);
    for (const name of names) {
      expect(normalizeDisplayName(name)).toBe(name);
    }
  });
});
