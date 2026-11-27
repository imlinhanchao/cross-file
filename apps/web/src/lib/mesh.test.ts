import { describe, expect, it } from "vitest";
import {
  handoverInfo,
  isPairOfferer,
  pairNeedsSas,
  roleAfterMembers,
  type PairElectionInput,
} from "./mesh.js";

function election(
  overrides: Partial<PairElectionInput> = {},
): PairElectionInput {
  return {
    selfId: "aaaa",
    peerId: "bbbb",
    selfIsAdmin: false,
    selfHasKey: true,
    ...overrides,
  };
}

describe("isPairOfferer", () => {
  it("the lexicographically smaller memberId offers", () => {
    expect(isPairOfferer(election({ selfId: "aaa", peerId: "bbb" }))).toBe(
      true,
    );
    expect(isPairOfferer(election({ selfId: "bbb", peerId: "aaa" }))).toBe(
      false,
    );
    // String comparison, not numeric: "10" < "9".
    expect(isPairOfferer(election({ selfId: "10", peerId: "9" }))).toBe(true);
  });

  it("the admin role does not matter for the election", () => {
    expect(
      isPairOfferer(
        election({ selfId: "aaa", peerId: "bbb", selfIsAdmin: true }),
      ),
    ).toBe(true);
    expect(
      isPairOfferer(
        election({ selfId: "bbb", peerId: "aaa", selfIsAdmin: true }),
      ),
    ).toBe(false);
  });

  it("6-digit SAS path: the admin offers the pair, whatever the ids say", () => {
    // Member without the key: it answers the admin's offer.
    expect(
      isPairOfferer(
        election({
          selfId: "aaa",
          peerId: "bbb",
          selfIsAdmin: false,
          selfHasKey: false,
        }),
      ),
    ).toBe(false);
    // Admin knows from join_request that the member has no key: it offers.
    expect(
      isPairOfferer(
        election({
          selfId: "zzz",
          peerId: "aaa",
          selfIsAdmin: true,
          peerHasKey: false,
        }),
      ),
    ).toBe(true);
  });
});

describe("pairNeedsSas", () => {
  it("is true only while one side lacks the roomKey", () => {
    expect(pairNeedsSas({ selfHasKey: true })).toBe(false);
    expect(pairNeedsSas({ selfHasKey: false })).toBe(true);
    expect(pairNeedsSas({ selfHasKey: true, peerHasKey: false })).toBe(true);
    expect(pairNeedsSas({ selfHasKey: true, peerHasKey: true })).toBe(false);
  });
});

describe("roleAfterMembers", () => {
  it("follows the server's isAdmin flag", () => {
    expect(roleAfterMembers("member", true)).toBe("admin");
    expect(roleAfterMembers("admin", false)).toBe("member");
    expect(roleAfterMembers("member", false)).toBe("member");
    expect(roleAfterMembers("admin", true)).toBe("admin");
  });

  it("keeps the current role when self is missing from the list", () => {
    expect(roleAfterMembers("admin", undefined)).toBe("admin");
    expect(roleAfterMembers("member", undefined)).toBe("member");
  });
});

describe("handoverInfo", () => {
  const oldAdmin = { id: "admin-1" };
  const newAdmin = { id: "member-1", name: "MacBook · 7K2F" };

  it("reports promotion when self is the new admin", () => {
    expect(handoverInfo(oldAdmin, newAdmin, "member-1")).toEqual({
      kind: "promoted",
    });
  });

  it("reports the new admin's name for everyone else", () => {
    expect(handoverInfo(oldAdmin, newAdmin, "member-2")).toEqual({
      kind: "handed-over",
      name: "MacBook · 7K2F",
    });
  });

  it("is quiet when the admin did not change (reconnect, rename, join)", () => {
    expect(
      handoverInfo(oldAdmin, { id: oldAdmin.id, name: "old" }, "member-1"),
    ).toBeNull();
    expect(handoverInfo(undefined, newAdmin, "member-1")).toBeNull();
    expect(handoverInfo(oldAdmin, undefined, "member-1")).toBeNull();
  });
});
