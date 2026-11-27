import { create } from "zustand";
import type { Caps, MemberInfo, PathLabel } from "@crossfile/core";

/**
 * Room client state (ADR 0010, docs/02 v2).
 *
 * One room = one admin plus N members; every member may send to and receive from
 * the others. Phase 1 only enables admin↔member, but the state shape is already
 * member-centric so phase 2 (mesh) does not need another rewrite.
 *
 * Compatibility: `guests`, `transfer`, `risk` and `hasKey` keep their v1 meaning
 * because Playwright assertions and the shells read them (`__crossfile.snapshot`).
 */

export type Phase =
  | "idle" // nothing happened yet
  | "provisioning" // connecting / creating room
  | "waiting" // room exists, nobody else joined yet
  | "approval" // admin: someone asked to join
  | "joined" // peer channels open
  | "transferring"
  | "paused"
  | "done"
  | "error";

/**
 * Per-member UI state. `pending`/`rejected` only exist on the admin side while a
 * join request waits for approval; `joined`/`offline` mirror the server's
 * `MemberInfo.state`, `transferring`/`done` are local progress decorations.
 */
export type MemberState =
  | "pending"
  | "joined"
  | "offline"
  | "transferring"
  | "done"
  | "removed"
  | "rejected";

export interface MemberView {
  id: string;
  name: string;
  caps: Caps;
  isAdmin: boolean;
  state: MemberState;
  path?: PathLabel;
  progress?: { sentBytes: number; totalBytes: number };
}

/** v1 compatibility: `guests` = every other member of the room. */
export interface ReceiverView {
  id: string;
  name?: string;
  caps: Caps;
  status:
    "pending" | "joined" | "transferring" | "done" | "removed" | "rejected";
  path?: PathLabel;
  progress?: { sentBytes: number; totalBytes: number };
}

export interface FileView {
  id: number;
  name: string;
  size: number;
  mime: string;
}

export interface TransferView {
  transferId: string;
  peerId: string;
  direction: "out" | "in";
  files: FileView[];
  sentBytes: number;
  totalBytes: number;
  path?: PathLabel;
  startedAt: number;
  speedBps: number;
  /** waiting for the other direction of the same pair to finish */
  queued?: boolean;
}

/** One queued outgoing transfer for a pair (phase 1: at most one pair). */
export interface QueueView {
  peerId: string;
  files: FileView[];
  totalBytes: number;
}

export interface RiskView {
  level: "ok" | "warn" | "reject";
  message: string;
  softLimitMB: number;
  hardLimitMB: number;
  totalBytes: number;
}

/** A manifest that waits for this device's consent (docs/02 v2 §3.6). */
export interface IncomingView {
  transferId: string;
  peerId: string;
  peerName: string;
  files: FileView[];
  totalBytes: number;
  risk?: RiskView;
}

export interface ResultView {
  ok: boolean;
  sha256?: string;
  expected?: string;
  url?: string;
  /** native shell only: where the file was written */
  path?: string;
  fileName?: string;
  bytes?: number;
}

export interface RoomView {
  role: "admin" | "member";
  phase: Phase;
  selfId?: string;
  selfName?: string;
  roomId?: string;
  code?: string;
  link?: string;
  members: MemberView[];
  /** Selected outgoing files (docs/01 D18 matrix: file × member). */
  files: FileView[];
  /** fileId -> member ids that should receive it */
  assignments: Record<number, string[]>;
  /** Active transfers keyed by the other member's id. */
  transfers: Record<string, TransferView>;
  /** Outgoing transfers waiting for the pair to become idle, in order. */
  queue: QueueView[];
  incoming?: IncomingView;
  /** v1 compatibility: the active transfer (outgoing first). */
  transfer?: TransferView;
  result?: ResultView;
  error?: string;
  errorCode?: string;
  notice?: string;
  roomClosed?: boolean;
  /** v1 compatibility: capability risk of the incoming manifest. */
  risk?: RiskView;
  /** 6-digit-code path: 4 emoji both sides compare before the key is sent */
  sas?: string[];
  sasPending?: boolean;
  sasConfirmedByMe?: boolean;
  codeMode?: boolean;
  hasKey?: boolean;
  /** v1 client hit a v2 server (docs/01 D22) or vice versa. */
  versionOutdated?: boolean;
  /** Auto-accept preference (docs/02 §11.3): user setting, default off. */
  autoAccept: boolean;
  /** Visible toast while an auto-accepted manifest starts. */
  autoAcceptNotice?: string;
  /** Admin hand-over notice (promoted member / everyone else), docs/02 §11.2. */
  handoverNotice?: string;
  /** Reconnect went stale (old admin after hand-over, expired rejoin token). */
  rejoinLost?: boolean;
  /** v1 compatibility: every other member, in join order. */
  guests: ReceiverView[];
}

interface AppStore extends RoomView {
  reset(view: Partial<RoomView>): void;
  patch(view: Partial<RoomView>): void;
  /** Replace the server member list, keeping local path/progress decorations. */
  setMembers(members: MemberInfo[]): void;
  /** Admin side: show a join request that is not in the member list yet. */
  upsertPending(member: MemberView): void;
  patchMember(id: string, patch: Partial<MemberView>): void;
  removeMember(id: string): void;
  setFiles(files: FileView[], assignments: Record<number, string[]>): void;
  setAssignments(next: Record<number, string[]>): void;
  toggleAssignment(fileId: number, memberId: string): void;
  setTransfer(peerId: string, view: TransferView): void;
  patchTransfer(peerId: string, patch: Partial<TransferView>): void;
  clearTransfer(peerId: string): void;
  setQueue(queue: QueueView[]): void;
  setIncoming(incoming: IncomingView | undefined): void;
  setResult(result: ResultView | undefined): void;
}

const MEMBER_STATE: Record<MemberState, ReceiverView["status"]> = {
  pending: "pending",
  joined: "joined",
  offline: "joined",
  transferring: "transferring",
  done: "done",
  removed: "removed",
  rejected: "rejected",
};

/** v1 `guests` view derived from the member list (everyone except ourselves). */
function guestsOf(view: RoomView): ReceiverView[] {
  return view.members
    .filter((member) => member.id !== view.selfId)
    .map((member) => ({
      id: member.id,
      name: member.name,
      caps: member.caps,
      status: MEMBER_STATE[member.state],
      ...(member.path ? { path: member.path } : {}),
      ...(member.progress ? { progress: member.progress } : {}),
    }));
}

/** v1 `transfer` view: the most relevant active transfer, outgoing first. */
function transferOf(view: RoomView): TransferView | undefined {
  const list = Object.values(view.transfers).filter(
    (transfer) => transfer.totalBytes > 0 || transfer.sentBytes > 0,
  );
  return (
    list.find((transfer) => transfer.direction === "out" && !transfer.queued) ??
    list.find((transfer) => transfer.direction === "in") ??
    list[0]
  );
}

/** Recompute the v1 compatibility fields from the member/transfer maps. */
function withCompat<T extends Partial<RoomView>>(
  view: T,
): T & Partial<RoomView> {
  return {
    ...view,
    ...(view.members ? { guests: guestsOf(view as unknown as RoomView) } : {}),
    ...(view.transfers
      ? { transfer: transferOf(view as unknown as RoomView) }
      : {}),
    ...(view.incoming !== undefined ? { risk: view.incoming?.risk } : {}),
  };
}

export const useApp = create<AppStore>((set) => ({
  role: "admin",
  phase: "idle",
  members: [],
  files: [],
  assignments: {},
  transfers: {},
  queue: [],
  guests: [],
  autoAccept: false,
  reset: (view) =>
    set({
      members: [],
      files: [],
      assignments: {},
      transfers: {},
      queue: [],
      guests: [],
      incoming: undefined,
      transfer: undefined,
      result: undefined,
      risk: undefined,
      error: undefined,
      errorCode: undefined,
      notice: undefined,
      roomClosed: false,
      versionOutdated: false,
      autoAccept: false,
      autoAcceptNotice: undefined,
      handoverNotice: undefined,
      rejoinLost: false,
      ...view,
    }),
  patch: (view) => set((state) => withCompat({ ...state, ...view })),
  setMembers: (members) =>
    set((state) => {
      const previous = new Map(state.members.map((entry) => [entry.id, entry]));
      // Keep join requests that the server has not put into the member list yet.
      const pending = state.members.filter(
        (entry) =>
          entry.state === "pending" && !members.some((m) => m.id === entry.id),
      );
      const merged: MemberView[] = members.map((member) => {
        const old = previous.get(member.id);
        return {
          id: member.id,
          name: member.name,
          caps: member.caps,
          isAdmin: member.isAdmin,
          state:
            member.state === "offline" ? "offline" : (old?.state ?? "joined"),
          ...(old?.path ? { path: old.path } : {}),
          ...(old?.progress ? { progress: old.progress } : {}),
        };
      });
      return withCompat({ ...state, members: [...merged, ...pending] });
    }),
  upsertPending: (member) =>
    set((state) => {
      const exists = state.members.some((entry) => entry.id === member.id);
      const members = exists
        ? state.members.map((entry) =>
            entry.id === member.id ? { ...entry, ...member } : entry,
          )
        : [...state.members, member];
      return withCompat({ ...state, members });
    }),
  patchMember: (id, patch) =>
    set((state) =>
      withCompat({
        ...state,
        members: state.members.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      }),
    ),
  removeMember: (id) =>
    set((state) => {
      const { [id]: _removed, ...transfers } = state.transfers;
      return withCompat({
        ...state,
        members: state.members.filter((entry) => entry.id !== id),
        transfers,
        queue: state.queue.filter((entry) => entry.peerId !== id),
      });
    }),
  setFiles: (files, assignments) =>
    set((state) => withCompat({ ...state, files, assignments })),
  setAssignments: (next) =>
    set((state) => withCompat({ ...state, assignments: next })),
  toggleAssignment: (fileId, memberId) =>
    set((state) => {
      const current = state.assignments[fileId] ?? [];
      const next = current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId];
      return withCompat({
        ...state,
        assignments: { ...state.assignments, [fileId]: next },
      });
    }),
  setTransfer: (peerId, view) =>
    set((state) =>
      withCompat({
        ...state,
        transfers: { ...state.transfers, [peerId]: view },
        queue: state.queue.filter((entry) => entry.peerId !== peerId),
      }),
    ),
  patchTransfer: (peerId, patch) =>
    set((state) => {
      const current = state.transfers[peerId];
      if (!current) return withCompat(state);
      return withCompat({
        ...state,
        transfers: {
          ...state.transfers,
          [peerId]: { ...current, ...patch },
        },
      });
    }),
  clearTransfer: (peerId) =>
    set((state) => {
      const { [peerId]: _removed, ...transfers } = state.transfers;
      return withCompat({ ...state, transfers });
    }),
  setQueue: (queue) => set((state) => withCompat({ ...state, queue })),
  setIncoming: (incoming) => set((state) => withCompat({ ...state, incoming })),
  setResult: (result) => set((state) => withCompat({ ...state, result })),
}));

/** Read the current room snapshot (used by the debug hook and controllers). */
export function roomSnapshot(): RoomView {
  return useApp.getState();
}
