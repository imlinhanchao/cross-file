/**
 * In-memory room state (docs/02 §3.3, ADR 0010). Nothing here is persisted: a room is a plain
 * object in a Map, deleted on close/expiry, and gone when the process exits.
 *
 * A room is an admin plus its members. A member is `pending` while its join request waits for
 * the admin, `joined` once approved, and `offline` while its 60 s reconnect window is open
 * (`rejoinToken`). The room keeps only: roomId, admin identity/socket, members, code, roomKey-free
 * bookkeeping, timers. No IP, no user agent, no message history, no disk.
 */
import type { Caps, MemberInfo } from "@crossfile/core/protocol";
import { dedupeNames } from "@crossfile/core/identity";
import type { WebSocket } from "ws";

/** docs/02 §3.3 room state machine: created → awaiting_approval → joined. */
export type RoomState = "created" | "awaiting_approval" | "joined";

export type MemberState = "pending" | "joined" | "offline";

export interface MemberRecord {
  /** Assigned by the server; also the id used by `signal.to` / `member_left`. */
  readonly id: string;
  /** Base name as reported/chosen; the effective (de-duplicated) name is computed on broadcast. */
  name: string;
  /** Reported on join, forwarded to the room; never copied elsewhere. */
  caps: Caps;
  readonly nonce: string;
  readonly proof?: string;
  state: MemberState;
  socket: WebSocket | null;
  /** Opaque token that lets this member re-attach inside the reconnect window (ADR 0010). */
  readonly rejoinToken: string;
  offlineTimer?: ReturnType<typeof setTimeout>;
}

export interface RoomRecord {
  readonly roomId: string;
  /** The creator. Phase 1: always the admin; phase 2 may hand the flag over (D24). */
  adminId: string;
  adminName: string;
  adminCaps: Caps;
  readonly adminRejoinToken: string;
  adminSocket: WebSocket | null;
  /** Set when the admin socket drops; the room survives the reconnect window and the TTL. */
  adminOffline: boolean;
  /** Join requests and approved members, in join order (the admin is not in this array). */
  readonly members: MemberRecord[];
  readonly createdAt: number;
  lastActivity: number;
  /** Six digit join code shown by the admin; reused when the admin reconnects. */
  readonly code: string;
  state: RoomState;
}

/** Members that appear in `members` broadcasts: approved, inside or outside their window. */
export function visibleMembers(room: RoomRecord): MemberRecord[] {
  return room.members.filter(
    (member) => member.state === "joined" || member.state === "offline",
  );
}

/**
 * Effective names for the whole room: the admin first, then members in join order, with
 * `-2`, `-3`, … appended on duplicates (ADR 0010 §names, docs/02 §1).
 */
export function effectiveNames(room: RoomRecord): string[] {
  return dedupeNames([
    room.adminName,
    ...visibleMembers(room).map((member) => member.name),
  ]);
}

export function effectiveAdminName(room: RoomRecord): string {
  return effectiveNames(room)[0] ?? room.adminName;
}

/** Full `members` snapshot: admin first (isAdmin), then members in join order. */
export function memberInfos(room: RoomRecord): MemberInfo[] {
  const names = effectiveNames(room);
  const infos: MemberInfo[] = [
    {
      id: room.adminId,
      name: names[0] ?? room.adminName,
      caps: room.adminCaps,
      isAdmin: true,
      state: room.adminOffline ? "offline" : "joined",
    },
  ];
  visibleMembers(room).forEach((member, index) => {
    infos.push({
      id: member.id,
      name: names[index + 1] ?? member.name,
      caps: member.caps,
      isAdmin: false,
      state: member.state === "joined" ? "joined" : "offline",
    });
  });
  return infos;
}

/** Effective name an approved member gets in the current room snapshot. */
export function effectiveMemberName(
  room: RoomRecord,
  member: MemberRecord,
): string {
  const index = visibleMembers(room).indexOf(member);
  if (index < 0) return member.name;
  return effectiveNames(room)[index + 1] ?? member.name;
}

/**
 * Effective name a still-pending member would get once approved. Used for `join_request`, so the
 * admin sees the same label the member will carry after approval.
 */
export function pendingName(room: RoomRecord, member: MemberRecord): string {
  const names = dedupeNames([
    room.adminName,
    ...visibleMembers(room).map((visible) => visible.name),
    member.name,
  ]);
  return names[names.length - 1] ?? member.name;
}

export class RoomStore {
  private readonly rooms = new Map<string, RoomRecord>();

  get(roomId: string): RoomRecord | undefined {
    return this.rooms.get(roomId);
  }

  set(room: RoomRecord): void {
    this.rooms.set(room.roomId, room);
  }

  delete(roomId: string): RoomRecord | undefined {
    const room = this.rooms.get(roomId);
    if (room) {
      clearMemberTimers(room);
      this.rooms.delete(roomId);
    }
    return room;
  }

  all(): IterableIterator<RoomRecord> {
    return this.rooms.values();
  }

  findMember(room: RoomRecord, memberId: string): MemberRecord | undefined {
    return room.members.find((member) => member.id === memberId);
  }

  /** Member holding a rejoin token, but only once it has been approved at least once. */
  findRejoinMember(
    room: RoomRecord,
    rejoinToken: string,
  ): MemberRecord | undefined {
    return room.members.find(
      (member) =>
        member.rejoinToken === rejoinToken && member.state !== "pending",
    );
  }

  removeMember(room: RoomRecord, member: MemberRecord): void {
    clearMemberTimer(member);
    const index = room.members.indexOf(member);
    if (index >= 0) room.members.splice(index, 1);
  }

  hasJoinedMember(room: RoomRecord): boolean {
    return visibleMembers(room).length > 0;
  }

  /**
   * Remove every room whose last activity is older than the TTL and hand them back so the
   * caller can notify the peers. This is the only delayed cleanup the protocol allows
   * (docs/01 D7: at most 30 minutes).
   */
  expire(nowMs: number, ttlMs: number): RoomRecord[] {
    const expired: RoomRecord[] = [];
    for (const room of this.rooms.values()) {
      if (nowMs - room.lastActivity > ttlMs) expired.push(room);
    }
    for (const room of expired) {
      clearMemberTimers(room);
      this.rooms.delete(room.roomId);
    }
    return expired;
  }

  clear(): void {
    for (const room of this.rooms.values()) clearMemberTimers(room);
    this.rooms.clear();
  }

  get size(): number {
    return this.rooms.size;
  }
}

/** Cancel one member's offline timer (rejoin, removal, shutdown). */
export function clearMemberTimer(member: MemberRecord): void {
  if (member.offlineTimer) {
    clearTimeout(member.offlineTimer);
    member.offlineTimer = undefined;
  }
}

/** Cancel every offline timer of a room before it is deleted. */
export function clearMemberTimers(room: RoomRecord): void {
  for (const member of room.members) clearMemberTimer(member);
}
