import { describe, expect, it } from "vitest";
import {
  buildRoomLink,
  createFileSalt,
  createGuestNonce,
  createRoomIdentity,
  normalizeJoinCode,
  parseRoomLink,
} from "./ids.js";
import { base32Decode, base32Encode } from "./bytes.js";
import { ROOM_KEY_BYTES } from "./ids.js";

describe("room identity", () => {
  it("generates a 26 character base32 roomId that round-trips", () => {
    const identity = createRoomIdentity();
    expect(identity.roomId).toMatch(/^[a-z2-7]{26}$/);
    expect(base32Decode(identity.roomId)).toHaveLength(16);
    expect(base32Encode(identity.roomIdBytes)).toBe(identity.roomId);
    expect(identity.roomKey).toHaveLength(ROOM_KEY_BYTES);
  });

  it("generates a fresh identity every time", () => {
    const a = createRoomIdentity();
    const b = createRoomIdentity();
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.roomKey).not.toEqual(b.roomKey);
  });
});

describe("join link", () => {
  it("keeps the key in the fragment and parses it back", () => {
    const identity = createRoomIdentity();
    const link = buildRoomLink(
      "https://room.example/",
      identity.roomId,
      identity.roomKey,
    );
    expect(link.startsWith(`https://room.example/r/${identity.roomId}#`)).toBe(
      true,
    );
    const parsed = parseRoomLink(link);
    expect(parsed?.roomId).toBe(identity.roomId);
    expect(parsed?.roomKey).toEqual(identity.roomKey);
  });

  it("strips trailing slashes from the origin", () => {
    const identity = createRoomIdentity();
    const link = buildRoomLink(
      "https://room.example///",
      identity.roomId,
      identity.roomKey,
    );
    expect(link.startsWith("https://room.example/r/")).toBe(true);
  });

  it("rejects links without a fragment or with the wrong key length", () => {
    const identity = createRoomIdentity();
    const withKey = buildRoomLink(
      "https://room.example",
      identity.roomId,
      identity.roomKey,
    );
    expect(parseRoomLink(withKey.split("#")[0]!)).toBeNull();
    expect(parseRoomLink(`${withKey.replace(/#.*/, "")}#AAAA`)).toBeNull();
    expect(parseRoomLink("https://room.example/not-a-room")).toBeNull();
    expect(parseRoomLink("not a url")).toBeNull();
  });
});

describe("nonces, salts and codes", () => {
  it("creates distinct base64url guest nonces", () => {
    const a = createGuestNonce();
    const b = createGuestNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("creates 4 byte file salts", () => {
    expect(createFileSalt()).toHaveLength(4);
  });

  it("normalises six digit join codes", () => {
    expect(normalizeJoinCode("482 913")).toBe("482913");
    expect(normalizeJoinCode("482913")).toBe("482913");
    expect(normalizeJoinCode("48291")).toBeNull();
    expect(normalizeJoinCode("abcdef")).toBeNull();
    expect(normalizeJoinCode("4829137")).toBeNull();
  });
});
