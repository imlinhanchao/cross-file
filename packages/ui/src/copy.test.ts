import { describe, expect, it } from "vitest";
import { copy, errorText, pathLabel } from "./copy.js";

describe("errorText", () => {
  it("maps every documented protocol code to actionable Chinese copy", () => {
    const codes = [
      "ROOM_NOT_FOUND",
      "ROOM_CLOSED",
      "ROOM_FULL",
      "PROOF_INVALID",
      "SAS_MISMATCH",
      "TOO_LARGE",
      "CAPABILITY_RISK_DECLINED",
      "HASH_MISMATCH",
      "TIMEOUT",
      "PEER_GONE",
      "RATE_LIMITED",
      "BAD_MESSAGE",
    ];
    for (const code of codes) {
      const text = errorText(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(code);
      expect(text).toMatch(/请|已/);
    }
  });

  it("falls back to the server message, then to the generic copy", () => {
    expect(errorText("SOMETHING_NEW", "server said no")).toBe("server said no");
    expect(errorText(undefined)).toBe(copy.errorGeneric);
    expect(errorText("SOMETHING_NEW")).toBe(copy.errorGeneric);
  });
});

describe("pathLabel", () => {
  it("labels all three ICE path rungs", () => {
    expect(pathLabel("lan")).toBe(copy.pathLan);
    expect(pathLabel("direct")).toBe(copy.pathDirect);
    expect(pathLabel("relay")).toBe(copy.pathRelay);
  });
});
