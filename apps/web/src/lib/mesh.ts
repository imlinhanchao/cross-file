/**
 * Pair-role election and hand-over bookkeeping for the member mesh
 * (ADR 0010 D23/D24, docs/02 §11.1).
 *
 * There is one `PeerConnection` per pair; its offerer is elected independently
 * and lazily by a pure, symmetric rule (both sides compute the same answer from
 * data they already have, so no negotiation message is needed):
 *
 * 1. the peer with the lexicographically smaller `memberId` (plain JS string
 *    `<`) is the offerer;
 * 2. the pair still needs the 6-digit-code SAS hand-over (one side has no
 *    roomKey) → the admin offers it, because the keyless member cannot
 *    initiate a pair. Only the admin↔member pair runs that ceremony; a
 *    member↔member pair simply waits for the key.
 */

export interface PairElectionInput {
  selfId: string;
  peerId: string;
  selfIsAdmin: boolean;
  /** both sides normally hold the roomKey; false on the 6-digit path before SAS */
  selfHasKey: boolean;
  /** admin only: what `join_request` said about the member's roomKey (undefined = unknown) */
  peerHasKey?: boolean;
}

/** True when this side still needs the 6-digit-code SAS hand-over for the pair. */
export function pairNeedsSas(
  input: Pick<PairElectionInput, "selfHasKey" | "peerHasKey">,
): boolean {
  return !input.selfHasKey || input.peerHasKey === false;
}

/** True when this side creates the offer for the pair (and rebuilds it after loss). */
export function isPairOfferer(input: PairElectionInput): boolean {
  if (pairNeedsSas(input)) return input.selfIsAdmin;
  return input.selfId < input.peerId;
}

/** The local role after a `members` broadcast; undefined self keeps the role. */
export function roleAfterMembers(
  current: "admin" | "member",
  selfIsAdmin: boolean | undefined,
): "admin" | "member" {
  if (selfIsAdmin === undefined) return current;
  return selfIsAdmin ? "admin" : "member";
}

export type HandoverInfo =
  { kind: "promoted" } | { kind: "handed-over"; name: string } | null;

/**
 * Detect an admin hand-over (docs/02 §11.2) by diffing two member snapshots.
 * The server sends no dedicated message: the `members` broadcast simply carries
 * a different `isAdmin` owner.
 */
export function handoverInfo(
  previousAdmin: { id: string } | undefined,
  currentAdmin: { id: string; name: string } | undefined,
  selfId: string,
): HandoverInfo {
  if (!previousAdmin || !currentAdmin) return null;
  if (previousAdmin.id === currentAdmin.id) return null;
  if (currentAdmin.id === selfId) return { kind: "promoted" };
  return { kind: "handed-over", name: currentAdmin.name };
}
