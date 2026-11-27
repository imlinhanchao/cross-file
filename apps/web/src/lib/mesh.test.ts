import { describe, expect, it } from "vitest";
import {
  handoverInfo,
  isPairOfferer,
  pairElectionSettled,
  pairNeedsSas,
  roleAfterMembers,
  type PairElectionInput,
} from "./mesh.js";

const MESH = { mesh: true };
const OLD = {};

function election(
  overrides: Partial<PairElectionInput> = {},
): PairElectionInput {
  return {
    selfId: "aaaa",
    peerId: "bbbb",
    selfIsAdmin: false,
    peerIsAdmin: false,
    selfMesh: true,
    peerCaps: MESH,
    selfHasKey: true,
    ...overrides,
  };
}

describe("isPairOfferer", () => {
  it("new-new: the lexicographically smaller memberId offers", () => {
    expect(isPairOfferer(election({ selfId: "aaa", peerId: "bbb" }))).toBe(
      true,
    );
    expect(isPairOfferer(election({ selfId: "bbb", peerId: "aaa" }))).toBe(
      false,
    );
    // String comparison, not numeric: "10" < "9".
    expect(isPairOfferer(election({ selfId: "10", peerId: "9" }))).toBe(true);
  });

  it("new-new: role of the admin does not matter for the election", () => {
    expect(
      isPairOfferer(
        election({
          selfId: "aaa",
          peerId: "bbb",
          selfIsAdmin: false,
          peerIsAdmin: true,
        }),
      ),
    ).toBe(true);
    expect(
      isPairOfferer(
        election({
          selfId: "bbb",
          peerId: "aaa",
          selfIsAdmin: true,
          peerIsAdmin: false,
        }),
      ),
    ).toBe(false);
  });

  it("new-old: falls back to 'the admin is the offerer' regardless of ids", () => {
    // New client is the smaller id but the old peer is the admin: admin offers.
    expect(
      isPairOfferer(
        election({
          selfId: "aaa",
          peerId: "bbb",
          selfIsAdmin: false,
          peerIsAdmin: true,
          peerCaps: OLD,
        }),
      ),
    ).toBe(false);
    // New client is the admin: it must offer, even though its id is larger.
    expect(
      isPairOfferer(
        election({
          selfId: "zzz",
          peerId: "aaa",
          selfIsAdmin: true,
          peerIsAdmin: false,
          peerCaps: OLD,
        }),
      ),
    ).toBe(true);
  });

  it("old-old: the admin is the offerer", () => {
    expect(
      isPairOfferer(
        election({
          selfId: "zzz",
          peerId: "aaa",
          selfMesh: false,
          selfIsAdmin: true,
          peerCaps: OLD,
        }),
      ),
    ).toBe(true);
    expect(
      isPairOfferer(
        election({
          selfId: "aaa",
          peerId: "zzz",
          selfMesh: false,
          selfIsAdmin: false,
          peerCaps: OLD,
        }),
      ),
    ).toBe(false);
  });

  it("caps unknown: conservative admin fallback, election not settled", () => {
    expect(pairElectionSettled(undefined)).toBe(false);
    expect(pairElectionSettled(OLD)).toBe(true);
    expect(
      isPairOfferer(
        election({ selfId: "aaa", peerId: "bbb", peerCaps: undefined }),
      ),
    ).toBe(false);
    expect(
      isPairOfferer(
        election({
          selfId: "zzz",
          peerId: "aaa",
          selfIsAdmin: true,
          peerCaps: undefined,
        }),
      ),
    ).toBe(true);
  });

  it("6-digit SAS path: the admin offers the pair, whatever the caps say", () => {
    // Member without the key: it answers the admin's offer.
    expect(
      isPairOfferer(
        election({
          selfId: "aaa",
          peerId: "bbb",
          selfIsAdmin: false,
          peerIsAdmin: true,
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
          peerIsAdmin: false,
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
