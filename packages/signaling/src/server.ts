/**
 * In-memory signaling server for CrossFile v2 (docs/02-protocol.md §3, ADR 0010).
 *
 * A room is an admin plus its members (docs/02 §3.3). Everything lives in process memory:
 * rooms, member ids, rejoin tokens, join codes, rate-limit counters. No database, no disk
 * writes, no cookies, no access logs, and no IP/UA stored on a room.
 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ERROR_CODES,
  HEARTBEAT_MS,
  MAX_MEMBERS,
  RECONNECT_WINDOW_MS,
  ROOM_TTL_MS,
  VersionMismatchError,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type TurnCredential,
} from "@crossfile/core/protocol";
import {
  defaultDisplayName,
  normalizeDisplayName,
} from "@crossfile/core/identity";
import { base64urlEncode, randomBytes } from "@crossfile/core/bytes";
import type { SignalingServer, SignalingServerOptions } from "./index.js";
import { logError } from "./log.js";
import { RateLimiter } from "./ratelimit.js";
import {
  RoomStore,
  clearMemberTimer,
  effectiveAdminName,
  effectiveMemberName,
  memberInfos,
  pendingName,
  visibleMembers,
  type MemberRecord,
  type RoomRecord,
} from "./rooms.js";
import { ShortCodeStore } from "./shortcode.js";
import {
  createStaticHandler,
  createStaticHandlerFromSource,
  type StaticHandler,
} from "./static.js";
import { issueTurnCredential } from "./turn.js";

const WS_PATH = "/v1/ws";
/** docs/02 §3.1: messages larger than 64 KiB are rejected (socket closes at the same limit). */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** impl-note: consecutive malformed frames tolerated before the connection is dropped. */
const MAX_CONSECUTIVE_BAD_MESSAGES = 5;
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 120 } as const;
/** docs/02 §7: periodic sweep; never later than a quarter of the room TTL. */
const SWEEP_MIN_MS = 10;
const SWEEP_MAX_MS = 5_000;
/** ADR 0010 risk note: `profile` is rate limited per connection, not only per IP. */
const PROFILE_RATE = { windowMs: 60_000, max: 10 } as const;
/** Version gate answer for v1 pages: the client shows this text and asks for a refresh. */
const VERSION_OUTDATED_MSG = "版本过旧，请刷新页面";
/** `ws` readyState OPEN; kept local so the server never imports a browser WebSocket global. */
const WS_OPEN = WebSocket.OPEN;

type CreateMessage = Extract<ClientMessage, { type: "create" }>;
type JoinMessage = Extract<ClientMessage, { type: "join" }>;
type ApproveMessage = Extract<ClientMessage, { type: "approve" }>;
type DenyMessage = Extract<ClientMessage, { type: "deny" }>;
type RemoveMessage = Extract<ClientMessage, { type: "remove" }>;
type SignalMessage = Extract<ClientMessage, { type: "signal" }>;
type ProfileMessage = Extract<ClientMessage, { type: "profile" }>;
type HeartbeatMessage = Extract<ClientMessage, { type: "heartbeat" }>;
type CloseMessage = Extract<ClientMessage, { type: "close" }>;

interface ProfileWindow {
  start: number;
  count: number;
}

interface ConnectionState {
  /** docs/02 §7: used only as the in-memory rate-limit key; never copied onto a room. */
  readonly ip: string;
  violations: number;
  role: "admin" | "member" | null;
  roomId: string | null;
  memberId: string | null;
  /** ping/pong liveness for half-open sockets, driven by the keepalive timer. */
  alive: boolean;
  /** Per-connection `profile` budget (ADR 0010 risk note). */
  profileWindow: ProfileWindow | null;
}

/** What the connection is inside the room: the admin, or one member record. */
interface Participant {
  id: string;
  joined: boolean;
  socket: WebSocket | null;
}

type PreparedShortCode =
  | { status: "ok"; value: unknown; code: string | null }
  | { status: "unknown-code" };

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** 8 random bytes, base64url (docs/02 §1 `memberId`). */
function createPeerId(): string {
  return base64urlEncode(randomBytes(8));
}

/** Opaque rejoin secret (docs/02 §3.2): 16 random bytes, base64url. */
function createRejoinToken(): string {
  return base64urlEncode(randomBytes(16));
}

export function createSignalingServer(
  options: SignalingServerOptions = {},
): SignalingServer {
  if (options.staticDir && options.staticAssets)
    throw new Error("staticDir and staticAssets are mutually exclusive");
  const listenPort = options.port ?? DEFAULT_PORT;
  const listenHost = options.host ?? DEFAULT_HOST;
  const maxMembers = options.maxMembers ?? options.maxGuests ?? MAX_MEMBERS;
  const roomTtlMs = options.roomTtlMs ?? ROOM_TTL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const reconnectWindowMs = options.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const turn = options.turn;
  const sweepMs = Math.min(
    SWEEP_MAX_MS,
    Math.max(SWEEP_MIN_MS, Math.floor(roomTtlMs / 4)),
  );

  const rooms = new RoomStore();
  const codes = new ShortCodeStore();
  const limiter = new RateLimiter(rateLimit);
  const connections = new Map<WebSocket, ConnectionState>();

  let httpServer: HttpServer | null = null;
  let staticHandler: StaticHandler | null = null;
  let socketServer: WebSocketServer | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let activePort = listenPort;
  let stopping: Promise<void> | null = null;

  // --- sending helpers ------------------------------------------------------

  function send(socket: WebSocket | null, message: ServerMessage): void {
    if (!socket || socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      logError("send", error);
    }
  }

  function sendError(
    socket: WebSocket | null,
    code: ErrorCode,
    msg: string,
  ): void {
    send(socket, { v: 2, type: "error", code, msg });
  }

  function sendRoomClosed(
    socket: WebSocket | null,
    reason: "admin_close" | "ttl" | "error",
  ): void {
    send(socket, { v: 2, type: "room_closed", reason });
  }

  /** docs/02 §6.8: one credential per member per connection; nothing when TURN is unconfigured. */
  function turnFor(memberId: string): TurnCredential | undefined {
    return turn ? issueTurnCredential(turn, memberId) : undefined;
  }

  function createdMessage(room: RoomRecord): ServerMessage {
    const credential = turnFor(room.adminId);
    const base = {
      v: 2 as const,
      type: "created" as const,
      roomId: room.roomId,
      code: room.code,
      selfId: room.adminId,
      name: effectiveAdminName(room),
      members: memberInfos(room),
      rejoinToken: room.adminRejoinToken,
    };
    return credential ? { ...base, turn: credential } : base;
  }

  function joinOkMessage(
    room: RoomRecord,
    selfId: string,
    name: string,
    rejoinToken: string,
  ): ServerMessage {
    const credential = turnFor(selfId);
    const base = {
      v: 2 as const,
      type: "join_ok" as const,
      roomId: room.roomId,
      selfId,
      name,
      members: memberInfos(room),
      rejoinToken,
    };
    return credential ? { ...base, turn: credential } : base;
  }

  function joinRequestMessage(
    room: RoomRecord,
    member: MemberRecord,
  ): ServerMessage {
    return {
      v: 2,
      type: "join_request",
      memberId: member.id,
      caps: member.caps,
      nonce: member.nonce,
      ...(member.proof ? { proof: member.proof } : {}),
      name: pendingName(room, member),
    };
  }

  /** docs/02 §3.2: `members` is always a full snapshot, never an increment. */
  function broadcastMembers(room: RoomRecord): void {
    const message: ServerMessage = {
      v: 2,
      type: "members",
      members: memberInfos(room),
    };
    send(room.adminSocket, message);
    for (const member of room.members) {
      if (member.state === "pending") continue;
      send(member.socket, message);
    }
  }

  /** Replay pending join requests to an admin that just re-attached. */
  function replayPendingRequests(room: RoomRecord): void {
    for (const member of room.members) {
      if (member.state === "pending")
        send(room.adminSocket, joinRequestMessage(room, member));
    }
  }

  // --- connection helpers ---------------------------------------------------

  function bind(
    state: ConnectionState,
    role: "admin" | "member",
    roomId: string,
    memberId: string,
  ): void {
    state.role = role;
    state.roomId = roomId;
    state.memberId = memberId;
  }

  function unbind(state: ConnectionState): void {
    state.role = null;
    state.roomId = null;
    state.memberId = null;
  }

  function adminRoom(ws: WebSocket, state: ConnectionState): RoomRecord | null {
    if (state.role !== "admin" || !state.roomId) {
      sendError(ws, "NOT_ADMIN", "only the admin can do that");
      return null;
    }
    const room = rooms.get(state.roomId);
    if (!room || room.adminSocket !== ws) {
      sendError(ws, "ROOM_NOT_FOUND", "admin room is gone");
      return null;
    }
    return room;
  }

  function recomputeRoomState(room: RoomRecord): void {
    if (rooms.hasJoinedMember(room)) room.state = "joined";
    else if (room.members.length > 0) room.state = "awaiting_approval";
    else room.state = "created";
  }

  /** Who this socket is inside the room (admin or member), if it is still bound to it. */
  function participant(
    room: RoomRecord,
    state: ConnectionState,
    ws: WebSocket,
  ): Participant | null {
    if (state.role === "admin" && room.adminSocket === ws) {
      return { id: room.adminId, joined: !room.adminOffline, socket: ws };
    }
    if (state.role === "member" && state.memberId) {
      const member = rooms.findMember(room, state.memberId);
      if (member && member.socket === ws) {
        return {
          id: member.id,
          joined: member.state === "joined",
          socket: ws,
        };
      }
    }
    return null;
  }

  /** Close and unbind a socket that was superseded by a rejoin from the same member. */
  function retireSocket(socket: WebSocket): void {
    const state = connections.get(socket);
    if (state) unbind(state);
    try {
      socket.close(1000, "superseded by a reconnect");
    } catch {
      // already closed
    }
  }

  /** Detach a member record: cancel its timer, forget it and unbind its socket. */
  function detachMember(room: RoomRecord, member: MemberRecord): void {
    const socket = member.socket;
    rooms.removeMember(room, member);
    member.socket = null;
    if (socket) {
      const state = connections.get(socket);
      if (state) unbind(state);
    }
  }

  // --- message preparation --------------------------------------------------

  /**
   * impl-note: the message table only defines `join {roomId}`, while §3.5 says the server maps
   * the six digit code to a roomId. We therefore accept a six digit value in `join.roomId`
   * (e.g. "042913"): it is resolved to the room id here and consumed by handleJoin once the
   * join succeeds. A QR/link join always sends the 26 character roomId.
   */
  function prepareShortCode(raw: unknown): PreparedShortCode {
    if (
      raw !== null &&
      typeof raw === "object" &&
      (raw as { type?: unknown }).type === "join"
    ) {
      const candidate = (raw as { roomId?: unknown }).roomId;
      if (typeof candidate === "string" && /^\d{6}$/.test(candidate)) {
        const roomId = codes.resolve(candidate);
        if (!roomId) return { status: "unknown-code" };
        return {
          status: "ok",
          value: { ...(raw as Record<string, unknown>), roomId },
          code: candidate,
        };
      }
    }
    return { status: "ok", value: raw, code: null };
  }

  function rejectMessage(
    ws: WebSocket,
    state: ConnectionState,
    reason: string,
  ): void {
    state.violations += 1;
    sendError(ws, "BAD_MESSAGE", reason);
    if (state.violations >= MAX_CONSECUTIVE_BAD_MESSAGES) {
      state.violations = 0;
      ws.close(1008, "too many malformed messages");
    }
  }

  function takeProfileBudget(state: ConnectionState): boolean {
    const at = Date.now();
    const window = state.profileWindow;
    if (!window || at >= window.start + PROFILE_RATE.windowMs) {
      state.profileWindow = { start: at, count: 1 };
      return true;
    }
    if (window.count >= PROFILE_RATE.max) return false;
    window.count += 1;
    return true;
  }

  function handleFrame(
    ws: WebSocket,
    state: ConnectionState,
    data: RawData,
    isBinary: boolean,
  ): void {
    const bytes = toBuffer(data);
    if (bytes.byteLength > MAX_MESSAGE_BYTES) {
      ws.close(1009, "message too large");
      return;
    }
    if (!limiter.take(state.ip)) {
      sendError(ws, "RATE_LIMITED", "too many signaling messages");
      ws.close(1008, "rate limited");
      return;
    }
    if (isBinary) {
      rejectMessage(
        ws,
        state,
        "binary frames are not accepted, signaling is JSON text",
      );
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      rejectMessage(ws, state, "message is not valid JSON");
      return;
    }
    const prepared = prepareShortCode(raw);
    if (prepared.status === "unknown-code") {
      // A wrong/expired code is not a malformed frame; answer like an unknown room.
      sendError(ws, "ROOM_NOT_FOUND", "join code is invalid or expired");
      state.violations = 0;
      return;
    }
    let message: ClientMessage;
    try {
      message = parseClientMessage(prepared.value);
    } catch (error) {
      // ADR 0010 §版本门禁: a page speaking v1 must be told to refresh, not left half-broken.
      if (error instanceof VersionMismatchError) {
        sendError(ws, "VERSION_MISMATCH", VERSION_OUTDATED_MSG);
        ws.close(1008, "protocol version mismatch");
        return;
      }
      rejectMessage(ws, state, "message does not match the protocol");
      return;
    }
    state.violations = 0;
    try {
      dispatch(ws, state, message, prepared.code);
    } catch (error) {
      logError("dispatch", error);
    }
  }

  function dispatch(
    ws: WebSocket,
    state: ConnectionState,
    message: ClientMessage,
    code: string | null,
  ): void {
    switch (message.type) {
      case "hello":
        // docs/02 §3.2: client capabilities arrive per join/create; the server keeps nothing.
        return;
      case "create":
        handleCreate(ws, state, message);
        return;
      case "join":
        handleJoin(ws, state, message, code);
        return;
      case "approve":
        handleApprove(ws, state, message);
        return;
      case "deny":
        handleDeny(ws, state, message);
        return;
      case "remove":
        handleRemove(ws, state, message);
        return;
      case "signal":
        handleSignal(ws, state, message);
        return;
      case "profile":
        handleProfile(ws, state, message);
        return;
      case "heartbeat":
        handleHeartbeat(ws, message);
        return;
      case "close":
        handleClose(ws, state, message);
        return;
    }
  }

  // --- client message handlers ----------------------------------------------

  function handleCreate(
    ws: WebSocket,
    state: ConnectionState,
    message: CreateMessage,
  ): void {
    if (state.role !== null) {
      sendError(ws, "BAD_MESSAGE", "connection is already bound to a room");
      return;
    }
    const name = normalizeDisplayName(message.name);
    if (!name) {
      sendError(ws, "BAD_MESSAGE", "display name must be 1-16 characters");
      return;
    }
    const existing = rooms.get(message.roomId);
    if (existing) {
      const adminOnline =
        existing.adminSocket !== null &&
        existing.adminSocket !== ws &&
        existing.adminSocket.readyState === WS_OPEN;
      if (adminOnline) {
        sendError(ws, "ROOM_CLOSED", "room already has a connected admin");
        return;
      }
      // impl-note: admin reconnect — the room, its code and its members survive admin socket
      // loss, so a repeated create with the same roomId re-attaches the new socket
      // (docs/02 §3.3, 60 s reconnect window).
      if (existing.adminSocket && existing.adminSocket !== ws) {
        retireSocket(existing.adminSocket);
      }
      existing.adminSocket = ws;
      existing.adminOffline = false;
      existing.adminCaps = message.caps;
      existing.adminName = name;
      existing.lastActivity = Date.now();
      bind(state, "admin", existing.roomId, existing.adminId);
      send(ws, createdMessage(existing));
      broadcastMembers(existing);
      replayPendingRequests(existing);
      return;
    }
    const at = Date.now();
    const room: RoomRecord = {
      roomId: message.roomId,
      adminId: createPeerId(),
      adminName: name,
      adminCaps: message.caps,
      adminRejoinToken: createRejoinToken(),
      adminSocket: ws,
      adminOffline: false,
      members: [],
      createdAt: at,
      lastActivity: at,
      code: codes.issue(message.roomId),
      state: "created",
    };
    rooms.set(room);
    bind(state, "admin", room.roomId, room.adminId);
    send(ws, createdMessage(room));
  }

  function handleJoin(
    ws: WebSocket,
    state: ConnectionState,
    message: JoinMessage,
    code: string | null,
  ): void {
    if (state.role !== null) {
      sendError(ws, "BAD_MESSAGE", "connection is already bound to a room");
      return;
    }
    const room = rooms.get(message.roomId);
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "room not found");
      return;
    }
    if (message.rejoinToken) {
      rejoin(ws, state, room, message, message.rejoinToken);
      return;
    }
    if (!room.adminSocket || room.adminSocket.readyState !== WS_OPEN) {
      sendError(ws, "ROOM_CLOSED", "admin is offline");
      return;
    }
    if (room.members.length >= maxMembers) {
      sendError(ws, "ROOM_FULL", "room is full");
      return;
    }
    if (code !== null && codes.consume(code) === null) {
      sendError(ws, "ROOM_NOT_FOUND", "join code is invalid or expired");
      return;
    }
    const member: MemberRecord = {
      id: createPeerId(),
      // impl-note: `join` carries no display name (ADR 0010 §协议增量); the server seeds a
      // default from the capabilities and the client may rename itself via `profile`
      // right after join_ok (remembered device name, ADR 0010 §names).
      name: normalizeDisplayName(defaultDisplayName(message.caps)) ?? "设备",
      caps: message.caps,
      nonce: message.nonce,
      state: "pending",
      socket: ws,
      rejoinToken: createRejoinToken(),
      ...(message.proof ? { proof: message.proof } : {}),
    };
    room.members.push(member);
    room.lastActivity = Date.now();
    recomputeRoomState(room);
    bind(state, "member", room.roomId, member.id);
    // docs/02 §3.4: the proof (QR path) is opaque to S — no roomKey exists server side — so it
    // is forwarded verbatim and the admin validates it.
    send(room.adminSocket, joinRequestMessage(room, member));
  }

  /**
   * 60 s reconnect (docs/02 §6.6, ADR 0010): a member — or the admin — presenting its
   * `rejoinToken` re-attaches to its existing record without a new approval.
   */
  function rejoin(
    ws: WebSocket,
    state: ConnectionState,
    room: RoomRecord,
    message: JoinMessage,
    rejoinToken: string,
  ): void {
    if (rejoinToken === room.adminRejoinToken) {
      // `create` is the documented admin reconnect (docs/02 §3.3); accept the token path too.
      if (room.adminSocket && room.adminSocket !== ws) {
        retireSocket(room.adminSocket);
      }
      room.adminSocket = ws;
      room.adminOffline = false;
      room.adminCaps = message.caps;
      room.lastActivity = Date.now();
      bind(state, "admin", room.roomId, room.adminId);
      send(
        ws,
        joinOkMessage(
          room,
          room.adminId,
          effectiveAdminName(room),
          room.adminRejoinToken,
        ),
      );
      broadcastMembers(room);
      replayPendingRequests(room);
      return;
    }
    const member = rooms.findRejoinMember(room, rejoinToken);
    if (!member) {
      sendError(ws, "ROOM_NOT_FOUND", "rejoin token is invalid or expired");
      return;
    }
    if (member.socket && member.socket !== ws) {
      retireSocket(member.socket);
    }
    clearMemberTimer(member);
    member.socket = ws;
    member.state = "joined";
    member.caps = message.caps;
    room.lastActivity = Date.now();
    bind(state, "member", room.roomId, member.id);
    recomputeRoomState(room);
    send(
      ws,
      joinOkMessage(
        room,
        member.id,
        effectiveMemberName(room, member),
        member.rejoinToken,
      ),
    );
    broadcastMembers(room);
  }

  function handleApprove(
    ws: WebSocket,
    state: ConnectionState,
    message: ApproveMessage,
  ): void {
    const room = adminRoom(ws, state);
    if (!room) return;
    const member = rooms.findMember(room, message.memberId);
    if (!member || member.state !== "pending") {
      sendError(ws, "PEER_GONE", "member is no longer waiting");
      return;
    }
    member.state = "joined";
    room.lastActivity = Date.now();
    recomputeRoomState(room);
    send(
      member.socket,
      joinOkMessage(
        room,
        member.id,
        effectiveMemberName(room, member),
        member.rejoinToken,
      ),
    );
    broadcastMembers(room);
  }

  /**
   * impl-note: `deny.reason` is free text in the message table but `join_rejected.code` is an
   * error code. A known error code is passed through; otherwise we send ROOM_CLOSED and keep
   * the text as the human readable reason.
   */
  function denyOutcome(reason: string | undefined): {
    code: ErrorCode;
    reason: string;
  } {
    if (reason && (ERROR_CODES as readonly string[]).includes(reason))
      return { code: reason as ErrorCode, reason };
    return { code: "ROOM_CLOSED", reason: reason ?? "denied by admin" };
  }

  function handleDeny(
    ws: WebSocket,
    state: ConnectionState,
    message: DenyMessage,
  ): void {
    const room = adminRoom(ws, state);
    if (!room) return;
    const member = rooms.findMember(room, message.memberId);
    if (!member || member.state !== "pending") {
      sendError(ws, "PEER_GONE", "member is no longer waiting");
      return;
    }
    const outcome = denyOutcome(message.reason);
    send(member.socket, {
      v: 2,
      type: "join_rejected",
      code: outcome.code,
      reason: outcome.reason,
    });
    detachMember(room, member);
    recomputeRoomState(room);
    room.lastActivity = Date.now();
  }

  function handleRemove(
    ws: WebSocket,
    state: ConnectionState,
    message: RemoveMessage,
  ): void {
    const room = adminRoom(ws, state);
    if (!room) return;
    const member = rooms.findMember(room, message.memberId);
    if (!member) {
      sendError(ws, "PEER_GONE", "member is not in the room");
      return;
    }
    const socket = member.socket;
    detachMember(room, member);
    if (socket) {
      sendRoomClosed(socket, "error");
      try {
        socket.close(1000, "removed");
      } catch {
        // already closed
      }
    }
    broadcastMembers(room);
    send(room.adminSocket, { v: 2, type: "member_left", memberId: member.id });
    recomputeRoomState(room);
    room.lastActivity = Date.now();
  }

  function handleSignal(
    ws: WebSocket,
    state: ConnectionState,
    message: SignalMessage,
  ): void {
    if (!state.roomId || state.role === null) {
      sendError(ws, "ROOM_NOT_FOUND", "connection is not in a room");
      return;
    }
    const room = rooms.get(state.roomId);
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "room is gone");
      return;
    }
    const me = participant(room, state, ws);
    if (!me || !me.joined) {
      sendError(ws, "PEER_GONE", "sender is not joined yet");
      return;
    }
    // docs/02 §3.2/§3.6 (v2): `to` is any member id — the admin is a member too; there is no
    // "host" sentinel anymore.
    let target: WebSocket | null = null;
    if (message.to === room.adminId) {
      if (!room.adminOffline && room.adminSocket) target = room.adminSocket;
    } else {
      const member = rooms.findMember(room, message.to);
      if (member && member.state === "joined" && member.socket)
        target = member.socket;
    }
    if (!target || target.readyState !== WS_OPEN) {
      sendError(ws, "PEER_GONE", "no such peer in the room");
      return;
    }
    room.lastActivity = Date.now();
    send(target, {
      v: 2,
      type: "signal",
      from: me.id,
      payload: message.payload,
    });
  }

  function handleProfile(
    ws: WebSocket,
    state: ConnectionState,
    message: ProfileMessage,
  ): void {
    if (!state.roomId || !state.memberId || state.role === null) {
      sendError(ws, "ROOM_NOT_FOUND", "connection is not in a room");
      return;
    }
    const room = rooms.get(state.roomId);
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "room is gone");
      return;
    }
    const me = participant(room, state, ws);
    if (!me || !me.joined) {
      sendError(ws, "PEER_GONE", "member is not joined yet");
      return;
    }
    const name = normalizeDisplayName(message.name);
    if (!name) {
      sendError(ws, "BAD_MESSAGE", "display name must be 1-16 characters");
      return;
    }
    if (!takeProfileBudget(state)) {
      sendError(ws, "RATE_LIMITED", "too many display name changes");
      return;
    }
    if (state.role === "admin") {
      room.adminName = name;
    } else {
      const member = rooms.findMember(room, state.memberId);
      if (!member) {
        sendError(ws, "PEER_GONE", "member is not in the room");
        return;
      }
      member.name = name;
    }
    room.lastActivity = Date.now();
    broadcastMembers(room);
  }

  function handleHeartbeat(ws: WebSocket, message: HeartbeatMessage): void {
    // impl-note (phase 1): the room TTL is renewed by the admin's heartbeat, as in v1
    // (`docs/02 §3.2` still describes any-member heartbeats; phase 1 keeps the admin as the
    // session anchor, D8).
    const room = rooms.get(message.roomId);
    if (room && room.adminSocket === ws) room.lastActivity = Date.now();
  }

  function handleClose(
    ws: WebSocket,
    state: ConnectionState,
    message: CloseMessage,
  ): void {
    if (state.role !== "admin") {
      sendError(ws, "NOT_ADMIN", "only the admin can close the room");
      return;
    }
    const room = rooms.get(message.roomId);
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "room not found");
      return;
    }
    if (room.adminSocket !== ws) {
      sendError(ws, "ROOM_NOT_FOUND", "admin room is gone");
      return;
    }
    // docs/01 AC7 / docs/02 §3.3: close destroys the room immediately and leaves memory.
    for (const member of room.members) {
      const socket = member.socket;
      sendRoomClosed(socket, "admin_close");
      if (socket) {
        const memberState = connections.get(socket);
        if (memberState) unbind(memberState);
        try {
          socket.close(1000, "admin closed the room");
        } catch {
          // already closed
        }
      }
    }
    rooms.delete(room.roomId);
    codes.revokeRoom(room.roomId);
    unbind(state);
  }

  // --- socket lifecycle -----------------------------------------------------

  function handleDisconnect(ws: WebSocket, state: ConnectionState): void {
    connections.delete(ws);
    if (!state.roomId) return;
    const room = rooms.get(state.roomId);
    if (!room) return;
    if (state.role === "admin") {
      if (room.adminSocket === ws) {
        // impl-note: admin socket loss never destroys the room — the 60 s reconnect window
        // (docs/02 §6.6) and the ≤30 min idle TTL (docs/01 D7) decide when it disappears.
        room.adminSocket = null;
        room.adminOffline = true;
        broadcastMembers(room);
      }
      return;
    }
    if (state.role === "member" && state.memberId) {
      const member = rooms.findMember(room, state.memberId);
      if (!member || member.socket !== ws) return;
      if (member.state === "pending") {
        // A join request that never got approved leaves no trace in the member list.
        detachMember(room, member);
        recomputeRoomState(room);
        return;
      }
      // docs/02 §6.6 (v2, symmetric): members get the same 60 s window as the admin.
      member.socket = null;
      member.state = "offline";
      clearMemberTimer(member);
      member.offlineTimer = setTimeout(
        () => expireMember(room.roomId, member.id),
        reconnectWindowMs,
      );
      member.offlineTimer.unref?.();
      broadcastMembers(room);
    }
  }

  /** Reconnect window elapsed: forget the member and tell the admin (docs/02 §3.3). */
  function expireMember(roomId: string, memberId: string): void {
    const room = rooms.get(roomId);
    if (!room) return;
    const member = rooms.findMember(room, memberId);
    if (!member || member.state !== "offline") return;
    clearMemberTimer(member);
    rooms.removeMember(room, member);
    broadcastMembers(room);
    send(room.adminSocket, { v: 2, type: "member_left", memberId });
    recomputeRoomState(room);
  }

  function sweep(): void {
    const at = Date.now();
    for (const room of rooms.expire(at, roomTtlMs)) {
      for (const member of room.members) {
        const socket = member.socket;
        sendRoomClosed(socket, "ttl");
        if (socket) {
          const memberState = connections.get(socket);
          if (memberState) unbind(memberState);
          try {
            socket.close(1000, "room expired");
          } catch {
            // already closed
          }
        }
      }
      if (room.adminSocket) {
        // impl-note: the admin is notified that the room expired, but its socket stays open so
        // it can create a fresh room without reconnecting.
        sendRoomClosed(room.adminSocket, "ttl");
        const adminState = connections.get(room.adminSocket);
        if (adminState) unbind(adminState);
      }
      codes.revokeRoom(room.roomId);
    }
    codes.sweep();
    limiter.sweep();
  }

  function keepAlive(): void {
    for (const [ws, state] of connections) {
      if (ws.readyState !== WS_OPEN) continue;
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      try {
        ws.ping();
      } catch (error) {
        logError("ping", error);
      }
    }
  }

  function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    // No access logging (docs/02 §7). With staticDir the same origin serves the app;
    // otherwise only /v1/ws exists and everything else is a quiet 404.
    if (staticHandler?.ready && staticHandler(request, response)) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }

  function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const path = (request.url ?? "").split("?")[0];
    const server = socketServer;
    if (path !== WS_PATH || !server) {
      socket.destroy();
      return;
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      server.emit("connection", ws, request);
    });
  }

  // --- public lifecycle -----------------------------------------------------

  async function start(): Promise<{ port: number }> {
    if (httpServer) return { port: activePort };
    if (options?.staticAssets) {
      // SEA single binary: the web app is embedded (docs/02 §7).
      staticHandler = createStaticHandlerFromSource(options.staticAssets);
      if (!staticHandler.ready)
        logError("static", new Error("embedded assets lack index.html"));
    } else if (options?.staticDir) {
      staticHandler = await createStaticHandler(options.staticDir);
      if (!staticHandler.ready)
        logError("static", new Error(`no index.html in ${options.staticDir}`));
    }
    const server = createServer(handleRequest);
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES,
    });
    wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      const state: ConnectionState = {
        ip: request.socket.remoteAddress ?? "unknown",
        violations: 0,
        role: null,
        roomId: null,
        memberId: null,
        alive: true,
        profileWindow: null,
      };
      connections.set(ws, state);
      ws.on("message", (data: RawData, isBinary: boolean) =>
        handleFrame(ws, state, data, isBinary),
      );
      ws.on("pong", () => {
        state.alive = true;
      });
      ws.on("close", () => handleDisconnect(ws, state));
      ws.on("error", (error: Error) => {
        // docs/02 §3.1: a >64 KiB frame is expected input abuse — ws already closes it with
        // 1009, so it is not worth an error-level log entry.
        if (error.message === "Max payload size exceeded") return;
        logError("socket", error);
      });
    });
    wss.on("error", (error: Error) => logError("ws-server", error));
    server.on("upgrade", handleUpgrade);
    server.on("clientError", (_error, socket) => socket.destroy());
    httpServer = server;
    socketServer = wss;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(listenPort, listenHost);
      });
    } catch (error) {
      httpServer = null;
      socketServer = null;
      try {
        server.close();
      } catch {
        // never listening
      }
      throw error;
    }
    const address = server.address();
    activePort =
      typeof address === "object" && address !== null
        ? address.port
        : listenPort;
    sweepTimer = setInterval(sweep, sweepMs);
    keepAliveTimer = setInterval(keepAlive, heartbeatMs);
    sweepTimer.unref?.();
    keepAliveTimer.unref?.();
    return { port: activePort };
  }

  async function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      // docs/02 §7.4: graceful shutdown clears every piece of in-memory state.
      for (const ws of connections.keys()) {
        try {
          ws.terminate();
        } catch {
          // already closed
        }
      }
      connections.clear();
      rooms.clear();
      codes.clear();
      limiter.clear();
      const wss = socketServer;
      socketServer = null;
      if (wss) {
        try {
          wss.close();
        } catch {
          // already closed
        }
      }
      const server = httpServer;
      httpServer = null;
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    })();
    try {
      await stopping;
    } finally {
      stopping = null;
    }
  }

  return { start, stop };
}
