/**
 * Ephemeral TURN credentials, coturn `static-auth-secret` mode (docs/02 §6.7).
 *
 *   username   = "<expiryEpoch>:<peerId>"
 *   credential = base64(HMAC-SHA1(secret, username))
 *
 * Credentials are derived on demand and never stored; TTL defaults to one hour
 * (TURN_TTL_SEC). Implementation note: `TurnOptions` is declared in index.ts (public surface)
 * and imported here as a type only, so this module has no runtime dependency on index.
 */
import { createHmac } from "node:crypto";
import { TURN_TTL_SEC, type TurnCredential } from "@crossfile/core/protocol";
import type { TurnOptions } from "./index.js";

export function issueTurnCredential(turn: TurnOptions, peerId: string, nowMs: number = Date.now()): TurnCredential {
  const ttl = turn.ttl ?? TURN_TTL_SEC;
  const expiry = Math.floor(nowMs / 1_000) + ttl;
  const username = `${expiry}:${peerId}`;
  const credential = createHmac("sha1", turn.secret).update(username).digest("base64");
  return { uris: [...turn.uris], username, credential, ttl };
}
