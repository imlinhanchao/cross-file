import { create } from "zustand";
import type { Caps, PathLabel } from "@crossfile/core";

export type Phase =
  | "idle" // nothing happened yet
  | "provisioning" // connecting / creating room
  | "waiting" // host: room exists, no guest yet
  | "approval" // host: a guest asked to join
  | "joined" // peer channels open
  | "transferring"
  | "paused"
  | "done"
  | "error";

export type ReceiverStatus =
  "pending" | "joined" | "transferring" | "done" | "removed" | "rejected";

export interface ReceiverView {
  id: string;
  caps: Caps;
  status: ReceiverStatus;
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
  sentBytes: number;
  totalBytes: number;
  path?: PathLabel;
  startedAt: number;
  speedBps: number;
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
  role: "host" | "guest";
  phase: Phase;
  roomId?: string;
  code?: string;
  link?: string;
  qrSvg?: string;
  hostCaps?: Caps;
  guests: ReceiverView[];
  files: FileView[];
  /** fileId -> guest ids that should receive it (docs/01 D18 file × person matrix) */
  assignments: Record<number, string[]>;
  transfer?: TransferView;
  result?: ResultView;
  error?: string;
  notice?: string;
  roomClosed?: boolean;
  /** receiver-side capability risk before accepting a manifest (docs/01 §6, D16) */
  risk?: {
    level: "ok" | "warn" | "reject";
    message: string;
    softLimitMB: number;
    totalBytes: number;
  };
  /** 6-digit-code path: 4 emoji both sides must compare before the key is sent */
  sas?: string[];
  sasPending?: boolean;
  sasConfirmedByMe?: boolean;
  codeMode?: boolean;
  hasKey?: boolean;
}

interface AppStore extends RoomView {
  reset(view: Partial<RoomView>): void;
  patch(view: Partial<RoomView>): void;
  upsertGuest(guest: ReceiverView): void;
  patchGuest(id: string, patch: Partial<ReceiverView>): void;
  removeGuest(id: string): void;
  setTransfer(patch: Partial<TransferView>): void;
  setAssignments(next: Record<number, string[]>): void;
  toggleAssignment(fileId: number, guestId: string): void;
}

export const useApp = create<AppStore>((set) => ({
  role: "host",
  phase: "idle",
  guests: [],
  files: [],
  assignments: {},
  reset: (view) =>
    set({
      guests: [],
      files: [],
      assignments: {},
      error: undefined,
      notice: undefined,
      result: undefined,
      transfer: undefined,
      roomClosed: false,
      ...view,
    }),
  patch: (view) => set(view),
  upsertGuest: (guest) =>
    set((state) => {
      const index = state.guests.findIndex((g) => g.id === guest.id);
      const guests =
        index >= 0
          ? state.guests.map((g) =>
              g.id === guest.id ? { ...g, ...guest } : g,
            )
          : [...state.guests, guest];
      return { guests };
    }),
  patchGuest: (id, patch) =>
    set((state) => ({
      guests: state.guests.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })),
  removeGuest: (id) =>
    set((state) => ({ guests: state.guests.filter((g) => g.id !== id) })),
  setAssignments: (next) => set({ assignments: next }),
  toggleAssignment: (fileId, guestId) =>
    set((state) => {
      const current = state.assignments[fileId] ?? [];
      const next = current.includes(guestId)
        ? current.filter((id) => id !== guestId)
        : [...current, guestId];
      return { assignments: { ...state.assignments, [fileId]: next } };
    }),
  setTransfer: (patch) =>
    set((state) => ({
      transfer: {
        sentBytes: 0,
        totalBytes: 0,
        startedAt: Date.now(),
        speedBps: 0,
        ...state.transfer,
        ...patch,
      },
    })),
}));
