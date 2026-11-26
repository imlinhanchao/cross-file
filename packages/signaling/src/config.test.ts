import { describe, expect, it } from "vitest";
import { parseMaxMembers } from "./config.js";

describe("parseMaxMembers", () => {
  it("returns undefined when unset, empty or whitespace", () => {
    expect(parseMaxMembers({})).toBeUndefined();
    expect(parseMaxMembers({ MAX_MEMBERS: "" })).toBeUndefined();
    expect(parseMaxMembers({ MAX_MEMBERS: "   " })).toBeUndefined();
    expect(parseMaxMembers({ MAX_GUESTS: "" })).toBeUndefined();
  });

  it("reads MAX_MEMBERS", () => {
    expect(parseMaxMembers({ MAX_MEMBERS: "2" })).toBe(2);
    expect(parseMaxMembers({ MAX_MEMBERS: " 4 " })).toBe(4);
  });

  it("accepts the legacy MAX_GUESTS alias", () => {
    expect(parseMaxMembers({ MAX_GUESTS: "3" })).toBe(3);
  });

  it("prefers MAX_MEMBERS over MAX_GUESTS", () => {
    expect(parseMaxMembers({ MAX_MEMBERS: "2", MAX_GUESTS: "4" })).toBe(2);
  });

  it("rejects values that are not positive integers", () => {
    for (const raw of ["0", "-1", "abc", "2.5", "2x", "1e3"]) {
      expect(() => parseMaxMembers({ MAX_MEMBERS: raw })).toThrow(
        /must be a positive integer/,
      );
      expect(() => parseMaxMembers({ MAX_GUESTS: raw })).toThrow(
        /must be a positive integer/,
      );
    }
  });
});
