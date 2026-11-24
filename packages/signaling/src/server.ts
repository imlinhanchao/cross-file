/**
 * In-memory signaling server for CrossFile (docs/02-protocol.md §3, §6.7, §7).
 *
 * Everything lives in process memory: rooms, peer ids, join codes, rate-limit counters.
 * No database, no disk writes, no cookies, no access logs, and no IP/UA stored on a room.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ERROR_CODES,
  HEARTBEAT_MS,
  MAX_GUESTS,
  ROOM_TTL_MS,
  parseClientMessage,
  type Caps,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type TurnCredential,
} from "@crossfile/core/protocol";
import { base64urlEncode, randomBytes } from "@crossfile/core/bytes";
import type { SignalingServer, SignalingServerOptions } from "./index.js";
import { logError } from "./log.js";
import { RateLimiter } from "./ratelimit.js";
import { RoomStore, type GuestRecord, type RoomRecord } from "./rooms.js";
import { ShortCodeStore } from "./shortcode.js";
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
/** `ws` readyState OPEN; kept local so the server never imports a browser WebSocket global. */
const WS_OPEN = WebSocket.OPEN;

type CreateMessage = Extract<ClientMessage, { type: "create" }>;
type JoinMessage = Extract<ClientMessage, { type: "join" }>;
type ApproveMessage = Extract<ClientMessage, { type: "approve" }>;
type DenyMessage = Extract<ClientMessage, { type: "deny" }>;
type RemoveMessage = Extract<ClientMessage, { type: "remove" }>;
type SignalMessage = Extract<ClientMessage, { type: "signal" }>;
type HeartbeatMessage = Extract<ClientMessage, { type: "heartbeat" }>;
type CloseMessage = Extract<ClientMessage, { type: "close" }>;

interface ConnectionState {
  /** docs/02 §7: used only as the in-memory rate-limit key; never copied onto a room. */
  readonly ip: string;
  violations: number;
  role: "host" | "guest" | null;
  roomId: string | null;
  guestId: string | null;
  /** ping/pong liveness for half-open sockets, driven by the keepalive timer. */
  alive: boolean;
}

type PreparedShortCode =
  | { status: "ok"; value: unknown; code: string | null }
  | { status: "unknown-code" };

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** 8 random bytes, base64url (docs/02 §1 `peerId`). */
function createPeerId(): string {
  return base64urlEncode(randomBytes(8));
}

export function createSignalingServer(options: SignalingServerOptions = {}): SignalingServer {
  const listenPort = options.port ?? DEFAULT_PORT;
  const listenHost = options.host ?? DEFAULT_HOST;
  const maxGuests = options.maxGuests ?? MAX_GUESTS;
  const roomTtlMs = options.roomTtlMs ?? ROOM_TTL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const turn = options.turn;
  const sweepMs = Math.min(SWEEP_MAX_MS, Math.max(SWEEP_MIN_MS, Math.floor(roomTtlMs / 4)));

  const rooms = new RoomStore();
  const codes = new ShortCodeStore();
  const limiter = new RateLimiter(rateLimit);
  const connections = new Map<WebSocket, ConnectionState>();

  let httpServer: HttpServer | null = null;
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

  function sendError(socket: WebSocket | null, code: ErrorCode, msg: string): void {
    send(socket, { v: 1, type: "error", code, msg });
  }

  function sendRoomClosed(socket: WebSocket | null, reason: "host_close" | "ttl" | "error"): void {
    send(socket, { v: 1, type: "room_closed", reason });
  }

  /** docs/02 §6.7: one credential per peer per connection; nothing when TURN is unconfigured. */
  function turnFor(peerId: string): TurnCredential | undefined {
    return turn ? issueTurnCredential(turn, peerId) : undefined;
  }

  function createdMessage(room: RoomRecord): ServerMessage {
    const credential = turnFor(room.hostPeerId);
    return credential
      ? { v: 1, type: "created", roomId: room.roomId, code: room.code, turn: credential }
      : { v: 1, type: "created", roomId: room.roomId, code: room.code };
  }

  /**
   * `peerCaps` always means "the other side's capabilities": hostCaps for a guest,
   * guestCaps for the host (web contract, docs/02 §3.2/§3.4).
   */
  function joinOk(guestId: string, peerCaps: Caps, credentialPeerId: string): ServerMessage {
    const credential = turnFor(credentialPeerId);
    if (!credential) {
      // impl-note: core's type marks join_ok.turn required, but docs/02 §6.7 only hands out
      // TURN credentials when coturn is configured; without a secret the field is omitted
      // instead of sending unusable placeholder credentials.
      return { v: 1, type: "join_ok", guestId, peerCaps } as ServerMessage;
    }
    return { v: 1, type: "join_ok", guestId, peerCaps, turn: credential };
  }

  // --- connection helpers ---------------------------------------------------

  function bind(state: ConnectionState, role: "host" | "guest", roomId: string, guestId: string | null): void {
    state.role = role;
    state.roomId = roomId;
    state.guestId = guestId;
  }

  function unbind(state: ConnectionState): void {
    state.role = null;
    state.roomId = null;
    state.guestId = null;
  }

  function roomForHost(ws: WebSocket, state: ConnectionState): RoomRecord | null {
    if (state.role !== "host" || !state.roomId) {
      sendError(ws, "BAD_MESSAGE", "only the host can do that");
      return null;
    }
    const room = rooms.get(state.roomId);
    if (!room || room.hostSocket !== ws) {
      sendError(ws, "ROOM_NOT_FOUND", "host room is gone");
      return null;
    }
    return room;
  }

  function recomputeRoomState(room: RoomRecord): void {
    if (rooms.hasJoinedGuest(room)) room.state = "joined";
    else if (room.guests.length > 0) room.state = "awaiting_approval";
    else room.state = "created";
  }

  function detachGuest(room: RoomRecord, guest: GuestRecord): void {
    rooms.removeGuest(room, guest);
    if (guest.socket) {
      const state = connections.get(guest.socket);
      if (state) unbind(state);
    }
  }

  function joinRequestMessage(guest: GuestRecord): ServerMessage {
    return {
      v: 1,
      type: "join_request",
      guestId: guest.guestId,
      guestCaps: guest.caps,
      guestNonce: guest.nonce,
      ...(guest.proof ? { proof: guest.proof } : {}),
    };
  }

  /**
   * impl-note: docs/02 §3.2/§3.4 do not say what a reconnecting host socket learns about the
   * room it re-attached to. We replay the state it needs to act (pending join requests and
   * joined peers), otherwise the guests kept across the reconnect could never be served.
   */
  function replayRoomState(room: RoomRecord): void {
    for (const guest of room.guests) {
      if (guest.state === "pending") send(room.hostSocket, joinRequestMessage(guest));
      else send(room.hostSocket, joinOk(guest.guestId, guest.caps, room.hostPeerId));
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
    if (raw !== null && typeof raw === "object" && (raw as { type?: unknown }).type === "join") {
      const candidate = (raw as { roomId?: unknown }).roomId;
      if (typeof candidate === "string" && /^\d{6}$/.test(candidate)) {
        const roomId = codes.resolve(candidate);
        if (!roomId) return { status: "unknown-code" };
        return { status: "ok", value: { ...(raw as Record<string, unknown>), roomId }, code: candidate };
      }
    }
    return { status: "ok", value: raw, code: null };
  }

  function rejectMessage(ws: WebSocket, state: ConnectionState, reason: string): void {
    state.violations += 1;
    sendError(ws, "BAD_MESSAGE", reason);
    if (state.violations >= MAX_CONSECUTIVE_BAD_MESSAGES) {
      state.violations = 0;
      ws.close(1008, "too many malformed messages");
    }
  }

  function handleFrame(ws: WebSocket, state: ConnectionState, data: RawData, isBinary: boolean): void {
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
      rejectMessage(ws, state, "binary frames are not accepted, signaling is JSON text");
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
    } catch {
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

  function dispatch(ws: WebSocket, state: ConnectionState, message: ClientMessage, code: string | null): void {
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
      case "heartbeat":
        handleHeartbeat(ws, message);
        return;
      case "close":
        handleClose(ws, state, message);
        return;
    }
  }

  // --- client message handlers ----------------------------------------------

  function handleCreate(ws: WebSocket, state: ConnectionState, message: CreateMessage): void {
    if (state.role !== null) {
      sendError(ws, "BAD_MESSAGE", "connection is already bound to a room");
      return;
    }
    const existing = rooms.get(message.roomId);
    if (existing) {
      const hostOnline = existing.hostSocket !== null && existing.hostSocket !== ws && existing.hostSocket.readyState === WS_OPEN;
      if (hostOnline) {
        sendError(ws, "ROOM_CLOSED", "room already has a connected host");
        return;
      }
      // impl-note: host reconnect — the room, its code and its guest list survive host socket
      // loss, so a repeated create with the same roomId re-attaches the new socket.
      existing.hostSocket = ws;
      existing.hostOffline = false;
      existing.hostPeerId = createPeerId();
      existing.hostCaps = message.hostCaps;
      existing.lastActivity = Date.now();
      bind(state, "host", existing.roomId, null);
      send(ws, createdMessage(existing));
      replayRoomState(existing);
      return;
    }
    const at = Date.now();
    const room: RoomRecord = {
      roomId: message.roomId,
      hostPeerId: createPeerId(),
      hostCaps: message.hostCaps,
      hostSocket: ws,
      hostOffline: false,
      guests: [],
      createdAt: at,
      lastActivity: at,
      code: codes.issue(message.roomId),
      state: "created",
    };
    rooms.set(room);
    bind(state, "host", room.roomId, null);
    send(ws, createdMessage(room));
  }

  function handleJoin(ws: WebSocket, state: ConnectionState, message: JoinMessage, code: string | null): void {
    if (state.role !== null) {
      sendError(ws, "BAD_MESSAGE", "connection is already bound to a room");
      return;
    }
    const room = rooms.get(message.roomId);
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "room not found");
      return;
    }
    if (!room.hostSocket || room.hostSocket.readyState !== WS_OPEN) {
      sendError(ws, "ROOM_CLOSED", "host is offline");
      return;
    }
    if (room.guests.length >= maxGuests) {
      sendError(ws, "ROOM_FULL", "room is full");
      return;
    }
    if (code !== null && codes.consume(code) === null) {
      sendError(ws, "ROOM_NOT_FOUND", "join code is invalid or expired");
      return;
    }
    const guestId = createPeerId();
    const guest: GuestRecord = {
      guestId,
      caps: message.guestCaps,
      nonce: message.guestNonce,
      state: "pending",
      socket: ws,
      ...(message.proof ? { proof: message.proof } : {}),
    };
    room.guests.push(guest);
    room.state = "awaiting_approval";
    room.lastActivity = Date.now();
    bind(state, "guest", room.roomId, guestId);
    // docs/02 §3.4: the proof (QR path) is opaque to S — no roomKey exists server side — so it
    // is forwarded verbatim and the host validates it.
    send(room.hostSocket, joinRequestMessage(guest));
  }

  function handleApprove(ws: WebSocket, state: ConnectionState, message: ApproveMessage): void {
    const room = roomForHost(ws, state);
    if (!room) return;
    const guest = rooms.findGuest(room, message.guestId);
    if (!guest) {
      sendError(ws, "PEER_GONE", "guest is no longer waiting");
      return;
    }
    guest.state = "joined";
    room.state = "joined";
    room.lastActivity = Date.now();
    // The guest learns the host's capabilities, the host learns the guest's; both also get
    // their own TURN credential. The host needs join_ok too: it starts the PeerConnection.
    send(guest.socket, joinOk(guest.guestId, room.hostCaps, guest.guestId));
    send(room.hostSocket, joinOk(guest.guestId, guest.caps, room.hostPeerId));
  }

  /**
   * impl-note: `deny.reason` is free text in the message table but `join_rejected.code` is an
   * error code. A known error code is passed through; otherwise we send ROOM_CLOSED and keep
   * the text as the human readable reason.
   */
  function denyOutcome(reason: string | undefined): { code: ErrorCode; reason: string } {
    if (reason && (ERROR_CODES as readonly string[]).includes(reason)) return { code: reason as ErrorCode, reason };
    return { code: "ROOM_CLOSED", reason: reason ?? "denied by host" };
  }

  function handleDeny(ws: WebSocket, state: ConnectionState, message: DenyMessage): void {
    const room = roomForHost(ws, state);
    if (!room) return;
    const guest = rooms.findGuest(room, message.guestId);
    if (!guest) {
      sendError(ws, "PEER_GONE", "guest is no longer waiting");
      return;
    }
    const outcome = denyOutcome(message.reason);
    send(guest.socket, { v: 1, type: "join_rejected", code: outcome.code, reason: outcome.reason });
    detachGuest(room, guest);
    recomputeRoomState(room);
    room.lastActivity = Date.now();
  }

  function handleRemove(ws: WebSocket, state: ConnectionState, message: RemoveMessage): void {
    const room = roomForHost(ws, state);
    if (!room) return;
    const guest = rooms.findGuest(room, message.guestId);
    if (!guest) {
      sendError(ws, "PEER_GONE", "guest is not in the room");
      return;
    }
    const socket = guest.socket;
    sendRoomClosed(socket, "error");
    detachGuest(room, guest);
    socket?.close(1000, "removed");
    send(room.hostSocket, { v: 1, type: "peer_left", guestId: message.guestId });
    recomputeRoomState(room);
    room.lastActivity = Date.now();
  }

  function handleSignal(ws: WebSocket, state: ConnectionState, message: SignalMessage): void {
    if (!state.roomId || state.role === null) {
      sendError(ws, "ROOM_NOT_FOUND", "connection is not in a room");
      return;
    }
    const room = rooms.get(state.roomId);
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "room is gone");
      return;
    }
    // docs/02 §3.2: `payload` is forwarded with its three whitelisted fields only; zod has
    // already dropped anything else (offer.sdp / answer.sdp / candidate fields).
    if (state.role === "host") {
      const guest = room.guests.find((candidate) => candidate.guestId === message.to && candidate.state === "joined");
      if (!guest) {
        sendError(ws, "PEER_GONE", "no such peer in the room");
        return;
      }
      room.lastActivity = Date.now();
      send(guest.socket, { v: 1, type: "signal", from: room.hostPeerId, payload: message.payload });
      return;
    }
    const me = room.guests.find((candidate) => candidate.guestId === state.guestId);
    if (!me || me.state !== "joined") {
      sendError(ws, "PEER_GONE", "guest is not joined yet");
      return;
    }
    // impl-note (web contract): a guest cannot know the host's peerId, so it addresses the
    // host with the sentinel "host"; both "host" and the actual hostPeerId route to the host.
    if (message.to !== "host" && message.to !== room.hostPeerId) {
      sendError(ws, "PEER_GONE", "no such peer in the room");
      return;
    }
    if (!room.hostSocket || room.hostSocket.readyState !== WS_OPEN) {
      sendError(ws, "PEER_GONE", "host is offline");
      return;
    }
    room.lastActivity = Date.now();
    send(room.hostSocket, { v: 1, type: "signal", from: me.guestId, payload: message.payload });
  }

  function handleHeartbeat(ws: WebSocket, message: HeartbeatMessage): void {
    // docs/02 §3.2 marks heartbeat host-only; a guest heartbeat is ignored (no error).
    const room = rooms.get(message.roomId);
    if (room && room.hostSocket === ws) room.lastActivity = Date.now();
  }

  function handleClose(ws: WebSocket, state: ConnectionState, message: CloseMessage): void {
    const room = rooms.get(message.roomId);
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "room not found");
      return;
    }
    if (room.hostSocket !== ws) {
      sendError(ws, "BAD_MESSAGE", "only the host can close the room");
      return;
    }
    // docs/01 AC7 / docs/02 §3.3: close destroys the room immediately and leaves memory.
    for (const guest of room.guests) {
      const socket = guest.socket;
      sendRoomClosed(socket, "host_close");
      if (socket) {
        const guestState = connections.get(socket);
        if (guestState) unbind(guestState);
      }
      socket?.close(1000, "host closed the room");
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
    if (state.role === "host") {
      if (room.hostSocket === ws) {
        // impl-note: host socket loss never destroys the room — the 60 s reconnect window
        // (docs/02 §6.5) and the ≤30 min idle TTL (docs/01 D7) decide when it disappears.
        room.hostSocket = null;
        room.hostOffline = true;
      }
      return;
    }
    if (state.role === "guest" && state.guestId) {
      const guest = rooms.findGuest(room, state.guestId);
      if (!guest) return;
      rooms.removeGuest(room, guest);
      send(room.hostSocket, { v: 1, type: "peer_left", guestId: guest.guestId });
      recomputeRoomState(room);
    }
  }

  function sweep(): void {
    const at = Date.now();
    for (const room of rooms.expire(at, roomTtlMs)) {
      for (const guest of room.guests) {
        const socket = guest.socket;
        sendRoomClosed(socket, "ttl");
        if (socket) {
          const guestState = connections.get(socket);
          if (guestState) unbind(guestState);
        }
        socket?.close(1000, "room expired");
      }
      if (room.hostSocket) {
        // impl-note: the host is notified that the room expired, but its socket stays open so
        // it can create a fresh room without reconnecting.
        sendRoomClosed(room.hostSocket, "ttl");
        const hostState = connections.get(room.hostSocket);
        if (hostState) unbind(hostState);
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

  function handleRequest(_request: IncomingMessage, response: ServerResponse): void {
    // No access logging (docs/02 §7); the signaling process only speaks WebSocket for now.
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
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
    const server = createServer(handleRequest);
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      const state: ConnectionState = {
        ip: request.socket.remoteAddress ?? "unknown",
        violations: 0,
        role: null,
        roomId: null,
        guestId: null,
        alive: true,
      };
      connections.set(ws, state);
      ws.on("message", (data: RawData, isBinary: boolean) => handleFrame(ws, state, data, isBinary));
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
    activePort = typeof address === "object" && address !== null ? address.port : listenPort;
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
