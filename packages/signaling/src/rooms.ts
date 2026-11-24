/**
 * In-memory room state (docs/02 §3.3). Nothing here is persisted: a room is a plain object
 * in a Map, deleted on close/expiry, and gone when the process exits.
 *
 * Per docs/02 §3.3 a room must only keep `roomId, hostPeerId, hostCaps, guests[], createdAt,
 * lastActivity`. The socket handles, the join code and the internal state string are extra
 * in-memory bookkeeping only — no IP, no user agent, no message history, no disk.
 */
import type { Caps } from "@crossfile/core/protocol";
import type { WebSocket } from "ws";

/** docs/02 §3.3 room state machine: created → awaiting_approval → joined. */
export type RoomState = "created" | "awaiting_approval" | "joined";

export type GuestState = "pending" | "joined";

export interface GuestRecord {
  /** Assigned by the server per connection; also the id used by `signal.to` / `peer_left`. */
  readonly guestId: string;
  /** Forwarded to the host on join_request and back to it on join_ok; never recorded elsewhere. */
  readonly caps: Caps;
  readonly nonce: string;
  readonly proof?: string;
  state: GuestState;
  socket: WebSocket | null;
}

export interface RoomRecord {
  readonly roomId: string;
  hostPeerId: string;
  hostCaps: Caps;
  hostSocket: WebSocket | null;
  /** Set when the host socket drops; the room survives for the reconnect window and TTL. */
  hostOffline: boolean;
  readonly guests: GuestRecord[];
  readonly createdAt: number;
  lastActivity: number;
  /** Six digit join code shown by the host; reused when the host reconnects. */
  readonly code: string;
  state: RoomState;
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
    if (room) this.rooms.delete(roomId);
    return room;
  }

  all(): IterableIterator<RoomRecord> {
    return this.rooms.values();
  }

  findGuest(room: RoomRecord, guestId: string): GuestRecord | undefined {
    return room.guests.find((guest) => guest.guestId === guestId);
  }

  removeGuest(room: RoomRecord, guest: GuestRecord): void {
    const index = room.guests.indexOf(guest);
    if (index >= 0) room.guests.splice(index, 1);
  }

  hasJoinedGuest(room: RoomRecord): boolean {
    return room.guests.some((guest) => guest.state === "joined");
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
    for (const room of expired) this.rooms.delete(room.roomId);
    return expired;
  }

  clear(): void {
    this.rooms.clear();
  }

  get size(): number {
    return this.rooms.size;
  }
}
