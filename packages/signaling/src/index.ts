/**
 * Public surface of `@crossfile/signaling`. The web app imports these names directly, so the
 * shape is frozen: createSignalingServer(options) → { start(), stop() }.
 *
 * Sources: docs/02-protocol.md §3 (room protocol), §6.7 (TURN credentials), §7 (zero storage).
 */
import { createSignalingServer as create } from "./server.js";

export interface TurnOptions {
  /** coturn URIs, e.g. ["turn:turn.example.org:3478?transport=udp"]. */
  uris: string[];
  /** coturn `static-auth-secret`. */
  secret: string;
  /** Credential lifetime in seconds; defaults to TURN_TTL_SEC (3600 s). */
  ttl?: number;
}

export interface SignalingServerOptions {
  /** TCP port; `0` binds an ephemeral port. Default 8788. */
  port?: number;
  /** Interface to bind. Default 127.0.0.1. */
  host?: string;
  /** TURN config; when absent the server never hands out TURN credentials. */
  turn?: TurnOptions;
  /** Maximum guests per room, pending + joined. Default 4 (official instance uses 2). */
  maxGuests?: number;
  /** Idle-room TTL. Default ROOM_TTL_MS from @crossfile/core. */
  roomTtlMs?: number;
  /** Socket keepalive cadence. Default HEARTBEAT_MS from @crossfile/core. */
  heartbeatMs?: number;
  /** Per-IP signaling budget. Default 60_000 ms / 120 messages. */
  rateLimit?: { windowMs: number; max: number };
  /**
   * Directory with the built web app (apps/web/dist). When set, the same process
   * serves the frontend and /v1/ws on one origin (docs/02 §7, ADR 0001).
   */
  staticDir?: string;
}

export interface SignalingServer {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

/**
 * Create an in-memory signaling server. Construction is side-effect free; `start()` binds the
 * socket and `stop()` releases every room, counter and timer.
 */
export function createSignalingServer(
  options?: SignalingServerOptions,
): SignalingServer {
  return create(options);
}
