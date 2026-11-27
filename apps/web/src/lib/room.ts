/**
 * Room controller (ADR 0010, docs/02 v2).
 *
 * One room = one admin plus N members; phase 1 enables admin↔member transfers.
 * This controller owns everything room-wide:
 *
 * - the signaling socket, identity/roomKey, member list and rejoin window,
 * - the display name (default `平台 · 代号`, editable, remembered locally),
 * - SAS + roomKey hand-over on the 6-digit-code path,
 * - one lazily attached {@link PeerSession} per pair; the offerer is elected by
 *   {@link isPairOfferer} (phase 2), the admin keeps offering old/SAS pairs,
 * - admin hand-over (role flip from a `members` broadcast) and the
 *   auto-accept preference,
 * - the send queue (file × member matrix) and the UI-facing store updates.
 */
import {
  HEARTBEAT_MS,
  RECONNECT_WINDOW_MS,
  base32Decode,
  base64urlDecode,
  base64urlEncode,
  buildRoomLink,
  computeJoinProof,
  createGuestNonce,
  createRoomIdentity,
  defaultDisplayName,
  deriveSessionKey,
  normalizeDisplayName,
  parseRoomLink,
  sasFromPeerConnection,
  verifyJoinProof,
  type Caps,
  type CtrlMessage,
  type MemberInfo,
  type PeerHandles,
  type ServerMessage,
  type SignalPayload,
  type TurnCredential,
} from "@crossfile/core";
import { copy, errorText, formatBytes } from "@crossfile/ui";
import { probeCaps } from "./caps.js";
import {
  installNativeShellHooks,
  isNativeShell,
  readShellConfig,
  setTransferActive,
} from "./native.js";
import { sasTimeoutMs, startTimeout, type TimeoutGuard } from "./timeout.js";
import { resolveSignalingUrl, SignalingSocket } from "./signal.js";
import { PeerSession, type PeerSessionHooks } from "./peer.js";
import {
  handoverInfo,
  isPairOfferer,
  pairElectionSettled,
  pairNeedsSas,
  roleAfterMembers,
} from "./mesh.js";
import type { SenderOutcome } from "./send.js";
import {
  useApp,
  type IncomingView,
  type QueueView,
  type ResultView,
  type RiskView,
} from "../store.js";

export type RoomMode =
  | { kind: "create" }
  | { kind: "join-link"; roomId: string; roomKey: Uint8Array }
  | { kind: "join-code"; code: string }
  | { kind: "auto" };

const NAME_STORAGE_KEY = "crossfile.displayName";
const AUTO_ACCEPT_STORAGE_KEY = "crossfile.autoAccept";
const REBUILD_DELAY_MS = 600;
const SAS_UNKNOWN_KEY_DELAY_MS = 1_200;

/** Fill a `{name}` template from copy.ts (same helper shape as RoomPage). */
function tpl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    String(vars[key] ?? ""),
  );
}

function readStoredName(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(NAME_STORAGE_KEY) ?? null;
    return raw ? normalizeDisplayName(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredName(name: string): void {
  try {
    globalThis.localStorage?.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Private mode / disabled storage: the name lasts for this session only.
  }
}

function clearStoredName(): void {
  try {
    globalThis.localStorage?.removeItem(NAME_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Auto-accept preference (docs/02 §11.3): a plain local setting, default off. */
function readAutoAccept(): boolean {
  try {
    return globalThis.localStorage?.getItem(AUTO_ACCEPT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAutoAccept(enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.setItem(AUTO_ACCEPT_STORAGE_KEY, "1");
    else globalThis.localStorage?.removeItem(AUTO_ACCEPT_STORAGE_KEY);
  } catch {
    // Private mode / disabled storage: the setting lasts for this session only.
  }
}

export class RoomController {
  private readonly mode: RoomMode;
  private caps: Caps = detectCapsFallback();
  private relayOnly = false;
  private role: "admin" | "member" = "admin";
  private socket = new SignalingSocket();
  private readonly peers = new Map<string, PeerSession>();
  private members: MemberInfo[] = [];
  private selfId = "";
  private selfName = "";
  private roomId = "";
  private roomKey: Uint8Array = new Uint8Array(0);
  private roomIdBytes: Uint8Array = new Uint8Array(0);
  private sessionKey: Uint8Array = new Uint8Array(0);
  private hasKey = false;
  private rejoinToken?: string;
  private turn?: TurnCredential;
  private fileList: File[] = [];
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cleanupNative?: () => void;
  private reportTimer?: ReturnType<typeof setInterval>;
  private intentionalClose = false;
  private roomClosed = false;
  private connected = false;
  private transferCounter = 0;
  /** files of the last failed/cancelled outgoing job per pair (re-send on 重试) */
  private readonly retryFiles = new Map<string, File[]>();
  private readonly memberHasKey = new Map<string, boolean>();
  private readonly keySent = new Set<string>();
  private sasPeerId?: string;
  private sasConfirmedByMe = false;
  private sasPeerConfirmed = false;
  private sasTimer: TimeoutGuard | null = null;
  private incomingResolver?: (granted: boolean) => void;
  private pendingIncoming?: IncomingView;
  private autoAcceptSetting = false;
  /** DEV-ONLY ?autoaccept=1 override, kept for the e2e suite (never persisted). */
  private devAutoAccept = false;
  /** pairs this side wants to send to (drives the lazy attach) */
  private readonly wantedPeers = new Set<string>();
  /** pairs whose peer sent a pair-request wake (it wants a channel but is not the offerer) */
  private readonly pairRequests = new Set<string>();
  /** wake was sent for this pair since its last attach attempt */
  private readonly wakeSent = new Set<string>();
  /** a reconnect attempt is in flight (a rejected create/rejoin then offers a re-join) */
  private reconnecting = false;
  /** true while the page is leaving for the normal join flow: never send `close` */
  private suppressAdminClose = false;
  private autoAcceptNoticeTimer?: ReturnType<typeof setTimeout>;
  private reportUrl: string | null = null;
  private native = isNativeShell();

  constructor(mode: RoomMode) {
    this.mode = mode;
  }

  get link(): string {
    return this.roomId && this.roomKey.length > 0
      ? buildRoomLink(location.origin, this.roomId, this.roomKey)
      : "";
  }

  get isAdmin(): boolean {
    return this.role === "admin";
  }

  /** The auto-accept preference in force (user setting, or the dev e2e override). */
  get autoAccept(): boolean {
    return this.autoAcceptSetting || this.devAutoAccept;
  }

  get fileNames(): string[] {
    return this.fileList.map((file) => file.name);
  }

  async start(): Promise<void> {
    this.relayOnly = new URLSearchParams(location.search).get("relay") === "1";
    this.detectDevFlags();
    this.autoAcceptSetting = readAutoAccept();
    const store = useApp.getState();
    this.role =
      this.mode.kind === "create" || this.mode.kind === "auto"
        ? "admin"
        : "member";
    store.reset({
      role: this.role,
      phase: "provisioning",
      autoAccept: this.autoAccept,
    });
    this.caps = await probeCaps();
    if (!this.native) {
      const shell = await readShellConfig();
      if (shell?.platform || shell?.shell) {
        this.native = true;
        this.caps = {
          ...this.caps,
          nativeShell: true,
          saveStrategies: ["native", "blob"],
        };
      }
    }
    this.selfName = readStoredName() ?? defaultDisplayName(this.caps);
    writeStoredName(this.selfName);

    const route = await this.resolveRoute();
    if (!route) {
      store.patch({
        phase: "error",
        error: "链接不完整：缺少房间密钥（# 后的部分）",
      });
      return;
    }
    this.role = route.role;
    store.patch({ role: this.role });
    if (route.kind === "create") {
      const identity = createRoomIdentity();
      this.roomId = identity.roomId;
      this.roomIdBytes = identity.roomIdBytes;
      this.roomKey = identity.roomKey;
    } else if (route.kind === "join-link") {
      this.roomId = route.roomId;
      this.roomKey = route.roomKey;
      this.roomIdBytes = base32Decode(route.roomId);
      store.patch({ hasKey: true, codeMode: false });
    } else {
      this.roomId = route.code;
      store.patch({ codeMode: true, hasKey: false });
    }
    this.hasKey = this.roomKey.length === 32;
    if (this.hasKey)
      this.sessionKey = deriveSessionKey(this.roomKey, this.roomIdBytes);

    this.installNativeHooks();
    this.installDebugReporting();
    this.socket.onMessage((message) => void this.onMessage(message));
    this.socket.onClose(() => this.onSocketClose());
    await this.socket.connect(await resolveSignalingUrl());
    this.connected = true;
    this.sendHello();
    this.sendCreateOrJoin();
    if (this.role === "member") {
      // Waiting for the admin's approval; join_ok arrives once it is granted.
      store.patch({ phase: "waiting", roomId: this.roomId, link: this.link });
    }
  }

  close(): void {
    this.intentionalClose = true;
    this.cleanupNative?.();
    void setTransferActive(false);
    this.resolveIncoming(false);
    this.pendingIncoming = undefined;
    if (
      this.role === "admin" &&
      this.roomId &&
      this.connected &&
      !this.roomClosed &&
      !this.suppressAdminClose
    ) {
      this.socket.send({
        v: 2,
        type: "close",
        roomId: this.roomId,
      });
    }
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.socket.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const timer of this.rebuildTimers.values()) clearTimeout(timer);
    this.rebuildTimers.clear();
    this.sasTimer?.cancel();
    if (this.reportTimer) clearInterval(this.reportTimer);
  }

  // --- user actions ---------------------------------------------------------

  setFiles(files: File[]): void {
    this.fileList = files;
    const store = useApp.getState();
    const views = files.map((file, index) => ({
      id: index + 1,
      name: file.name,
      size: file.size,
      mime: file.type,
    }));
    const targets = this.members
      .filter((member) => member.id !== this.selfId)
      .map((member) => member.id);
    const assignments: Record<number, string[]> = {};
    for (const view of views) assignments[view.id] = [...targets];
    store.setFiles(views, assignments);
  }

  /**
   * Start the transfers for the file × member matrix (one job per receiver).
   * Any member can send to any other member (docs/02 §11.1): the pair is created
   * lazily — this side attaches when it is the pair's offerer, otherwise it wakes
   * the offerer with a pair-request (see {@link wakePeer}) and the queued job
   * starts as soon as the pair opens.
   */
  sendNow(): void {
    const store = useApp.getState();
    if (this.fileList.length === 0) throw new Error(copy.selectFileFirst);
    if (!this.hasKey)
      throw new Error("还没有拿到房间密钥，等对方确认安全码后再发送。");
    const targets = this.members.filter((member) => member.id !== this.selfId);
    let started = 0;
    for (const member of targets) {
      const files = this.fileList.filter((_file, index) =>
        (store.assignments[index + 1] ?? []).includes(member.id),
      );
      if (files.length === 0) continue;
      const session = this.ensurePeer(member);
      this.retryFiles.delete(member.id);
      this.wantedPeers.add(member.id);
      this.maybeAttach(member.id);
      if (!session.hasHandles) this.wakePeer(member);
      session.enqueue(files);
      started += 1;
    }
    if (started === 0) throw new Error(copy.emptyReceivers);
  }

  /**
   * Cancel the pair's active transfer (sending or receiving side, docs/02 §10.2
   * cancel note). This is a normal end, not an error: the UI shows 已取消 and the
   * pair is idle again, so a queued job for the same pair starts immediately.
   */
  cancelTransfer(peerId: string): void {
    const store = useApp.getState();
    const transfer = store.transfers[peerId];
    if (
      !transfer ||
      transfer.cancelled ||
      transfer.failed ||
      transfer.completed
    )
      return;
    const session = this.peers.get(peerId);
    if (!session) return;
    // Patch first so the button responds before the transfer unwinds; the
    // sender/receiver callbacks repeat the same terminal state.
    store.patchTransfer(peerId, { cancelled: "local" });
    store.patch({
      phase: "cancelled",
      notice: copy.cancelledLocal,
      error: undefined,
      errorCode: undefined,
    });
    session.cancelActive();
  }

  /** Drop one *waiting* job; nothing is announced because the peer never saw it. */
  cancelQueued(peerId: string, jobId: number): void {
    const session = this.peers.get(peerId);
    if (!session) return;
    session.cancelQueued(jobId);
    useApp.getState().patch({ notice: copy.cancelQueuedNotice });
  }

  /**
   * Re-send the files of the last failed/cancelled outgoing job to the same
   * peer. A fresh job gets a fresh `transferId` in peer.ts, so the peer receives
   * a new manifest and accepts again — old ciphertext/bitmap state is never
   * reused (docs/02 §10.2 cancel note).
   */
  retryTransfer(peerId: string): void {
    const files = this.retryFiles.get(peerId);
    if (!files || files.length === 0) return;
    const session = this.peers.get(peerId);
    const member = this.memberInfo(peerId);
    if (!session || !member || member.state === "offline") return;
    if (session.busy) return;
    this.retryFiles.delete(peerId);
    const store = useApp.getState();
    store.clearTransfer(peerId);
    store.patch({
      notice: copy.retrying,
      error: undefined,
      errorCode: undefined,
    });
    this.wantedPeers.add(peerId);
    this.maybeAttach(peerId);
    if (!session.hasHandles) this.wakePeer(member);
    session.enqueue(files);
  }

  /** Toggle the room-wide auto-accept preference (docs/02 §11.3, default off). */
  setAutoAccept(enabled: boolean): void {
    this.autoAcceptSetting = enabled;
    writeAutoAccept(enabled);
    useApp.getState().patch({ autoAccept: this.autoAccept });
  }

  approve(memberId: string): void {
    this.socket.send({ v: 2, type: "approve", memberId });
    useApp.getState().patchMember(memberId, { state: "joined" });
  }

  deny(memberId: string): void {
    this.socket.send({ v: 2, type: "deny", memberId, reason: "declined" });
    useApp.getState().removeMember(memberId);
  }

  remove(memberId: string): void {
    this.socket.send({ v: 2, type: "remove", memberId });
    this.dropPeer(memberId);
    useApp.getState().removeMember(memberId);
  }

  /** Rename this device; returns an error message when the name is invalid. */
  rename(raw: string): string | null {
    const name = normalizeDisplayName(raw);
    if (!name) return "名称需要 1–16 个字符（不能只有空白）";
    this.selfName = name;
    writeStoredName(name);
    this.socket.send({ v: 2, type: "profile", name });
    this.patchSelfName(name);
    return null;
  }

  forgetName(): string {
    clearStoredName();
    const name = defaultDisplayName(this.caps);
    this.selfName = name;
    writeStoredName(name);
    if (this.connected) this.socket.send({ v: 2, type: "profile", name });
    this.patchSelfName(name);
    return name;
  }

  confirmSas(): void {
    if (!this.sasPeerId || this.sasConfirmedByMe) return;
    this.sasConfirmedByMe = true;
    this.peers.get(this.sasPeerId)?.sendControl({
      v: 2,
      type: "sas-confirm",
    });
    useApp.getState().patch({ sasConfirmedByMe: true });
    this.maybeSendRoomKey(this.sasPeerId);
  }

  acceptIncoming(): void {
    this.resolveIncoming(true);
  }

  declineIncoming(): void {
    this.resolveIncoming(false);
  }

  /**
   * Old admin after a hand-over (or a member whose rejoin token expired): the
   * room still exists, so leave the dead session through the normal join flow —
   * the peer's invite link carries the roomKey and the new admin approves.
   */
  rejoin(): void {
    const link = this.link;
    this.suppressAdminClose = true;
    this.intentionalClose = true;
    location.assign(link || "/");
  }

  /** AC12 test hook: kill the data path to one peer; it rebuilds and resumes. */
  forceDrop(peerId?: string): void {
    const target = peerId
      ? this.peers.get(peerId)
      : [...this.peers.values()][0];
    if (!target) return;
    useApp.getState().patch({ notice: copy.resumeHint });
    target.forceDrop();
  }

  // --- room wiring ----------------------------------------------------------

  private async resolveRoute(): Promise<
    | { kind: "create"; role: "admin" }
    | { kind: "join-link"; roomId: string; roomKey: Uint8Array; role: "member" }
    | { kind: "join-code"; code: string; role: "member" }
    | null
  > {
    if (this.mode.kind === "create") return { kind: "create", role: "admin" };
    if (this.mode.kind === "join-link")
      return {
        kind: "join-link",
        roomId: this.mode.roomId,
        roomKey: this.mode.roomKey,
        role: "member",
      };
    if (this.mode.kind === "join-code")
      return { kind: "join-code", code: this.mode.code, role: "member" };
    // auto: native debug shells pass the key as a query parameter so the page can
    // live on the shell's own origin (docs/05 §7.0.13); otherwise uri-parse.
    const params = new URLSearchParams(location.search);
    const devKey = params.get("devkey");
    if (devKey) {
      const shell = await readShellConfig();
      if (!shell?.debugAutoAccept) return null;
      const match = /^\/r\/([a-z2-7]+)\/?$/.exec(location.pathname);
      const devRoom = params.get("devroom") ?? "";
      const roomId = match?.[1] ?? devRoom;
      try {
        const roomKey = base64urlDecode(devKey);
        if (!roomId || roomKey.length !== 32) return null;
        return { kind: "join-link", roomId, roomKey, role: "member" };
      } catch {
        return null;
      }
    }
    const codeMatch = /^\/j\/(\d{6})\/?$/.exec(location.pathname);
    if (codeMatch?.[1]) {
      return { kind: "join-code", code: codeMatch[1], role: "member" };
    }
    const link = parseRoomLink(location.href);
    if (link)
      return {
        kind: "join-link",
        roomId: link.roomId,
        roomKey: link.roomKey,
        role: "member",
      };
    return { kind: "create", role: "admin" };
  }

  private detectDevFlags(): void {
    const params = new URLSearchParams(location.search);
    if (import.meta.env.DEV) {
      this.devAutoAccept = params.get("autoaccept") === "1";
      const report = params.get("report");
      this.reportUrl = report;
    }
  }

  private sendHello(): void {
    this.socket.send({ v: 2, type: "hello", clientCaps: this.caps });
  }

  private sendCreateOrJoin(): void {
    if (this.role === "admin") {
      this.socket.send({
        v: 2,
        type: "create",
        roomId: this.roomId,
        caps: this.caps,
        name: this.selfName,
      });
      return;
    }
    const nonce = createGuestNonce();
    this.socket.send({
      v: 2,
      type: "join",
      roomId: this.roomId,
      caps: this.caps,
      nonce,
      ...(this.hasKey
        ? {
            proof: computeJoinProof(this.roomKey, this.roomIdBytes, nonce),
          }
        : {}),
      ...(this.rejoinToken ? { rejoinToken: this.rejoinToken } : {}),
    });
  }

  private installNativeHooks(): void {
    this.cleanupNative = installNativeShellHooks({
      isTransferActive: () => isTransferActive(),
      onEndRoom: () => {
        this.close();
        location.assign("/");
      },
      onNewRoom: () => location.assign("/room"),
    });
  }

  private installDebugReporting(): void {
    if (!import.meta.env.DEV || !this.reportUrl) return;
    const url = this.reportUrl;
    this.reportTimer = setInterval(() => {
      const state = useApp.getState();
      const payload = {
        phase: state.phase,
        role: state.role,
        roomId: state.roomId,
        error: state.error,
        members: state.members.length,
        selfId: state.selfId,
        transfers: Object.keys(state.transfers),
      };
      void fetch(
        `${url}?tag=room-diag&data=${encodeURIComponent(JSON.stringify(payload))}`,
        { mode: "no-cors" },
      ).catch(() => undefined);
    }, 3_000);
  }

  // --- signaling ------------------------------------------------------------

  private onSocketClose(): void {
    if (this.intentionalClose || this.roomClosed) return;
    const state = useApp.getState();
    if (state.phase === "error" || state.phase === "idle") return;
    useApp.getState().patch({ notice: copy.reconnecting });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnecting = true;
    const deadline = Date.now() + RECONNECT_WINDOW_MS;
    const attempt = async (): Promise<void> => {
      this.reconnectTimer = undefined;
      if (this.intentionalClose || this.roomClosed) return;
      if (Date.now() > deadline) {
        useApp.getState().patch({
          phase: "error",
          error: copy.connectionLost,
        });
        return;
      }
      try {
        await this.socket.connect(await resolveSignalingUrl());
        this.connected = true;
        this.sendHello();
        this.sendCreateOrJoin();
      } catch {
        this.reconnectTimer = setTimeout(() => void attempt(), 1_000);
      }
    };
    this.reconnectTimer = setTimeout(() => void attempt(), 500);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.roomId)
        this.socket.send({ v: 2, type: "heartbeat", roomId: this.roomId });
    }, HEARTBEAT_MS);
  }

  private async onMessage(message: ServerMessage): Promise<void> {
    const store = useApp.getState();
    switch (message.type) {
      case "created": {
        this.clearReconnect();
        this.reconnecting = false;
        this.selfId = message.selfId;
        this.rejoinToken = message.rejoinToken;
        if (message.turn) this.turn = message.turn;
        if (message.name) this.selfName = message.name;
        store.patch({
          phase: this.members.length > 0 ? "joined" : "waiting",
          roomId: this.roomId,
          code: message.code,
          link: this.link,
          selfId: this.selfId,
          selfName: this.selfName,
          hasKey: true,
          notice: undefined,
        });
        this.applyMembers(message.members);
        this.startHeartbeat();
        // applyMembers() re-evaluates the lazy pairs (legacy/SAS pairs are
        // attached eagerly there; the rest only when a transfer needs them), so a
        // re-attached admin does not have to rebuild every pair by hand.
        break;
      }
      case "join_request": {
        if (message.proof !== undefined) {
          const valid = verifyJoinProof(
            this.roomKey,
            this.roomIdBytes,
            message.nonce,
            message.proof,
          );
          if (!valid) {
            this.socket.send({
              v: 2,
              type: "deny",
              memberId: message.memberId,
              reason: "PROOF_INVALID",
            });
            return;
          }
          this.memberHasKey.set(message.memberId, true);
        } else {
          this.memberHasKey.set(message.memberId, false);
        }
        store.upsertPending({
          id: message.memberId,
          name: message.name,
          caps: message.caps,
          isAdmin: false,
          state: "pending",
        });
        store.patch({ phase: "approval" });
        break;
      }
      case "join_ok": {
        this.clearReconnect();
        this.selfId = message.selfId;
        this.rejoinToken = message.rejoinToken;
        if (message.turn) this.turn = message.turn;
        store.patch({
          phase: "waiting",
          roomId: this.roomId,
          selfId: this.selfId,
          link: this.link,
          hasKey: this.hasKey,
          notice: undefined,
        });
        // Keep the locally remembered name: applyMembers() overwrites selfName with the
        // server-assigned default, so capture it first and make it authoritative.
        const localName = this.selfName;
        this.applyMembers(message.members);
        this.socket.send({ v: 2, type: "profile", name: localName });
        this.startHeartbeat();
        // Member reconnect: wait for the admin's fresh offer; existing pairs keep
        // their transfer state and re-announce it when the channels open.
        for (const member of message.members) {
          if (member.id === this.selfId) continue;
          this.ensurePeer(member);
        }
        break;
      }
      case "join_rejected": {
        const rejected = this.reconnecting;
        this.reconnecting = false;
        this.fail(
          message.code === "VERSION_MISMATCH"
            ? copy.versionOutdated
            : errorText(message.code, message.reason),
          message.code,
        );
        if (message.code === "VERSION_MISMATCH")
          store.patch({ versionOutdated: true });
        else if (
          rejected &&
          (message.code === "ROOM_NOT_FOUND" || message.code === "ROOM_CLOSED")
        ) {
          this.suppressAdminClose = true;
          store.patch({ rejoinLost: true });
        }
        break;
      }
      case "members": {
        this.applyMembers(message.members);
        break;
      }
      case "signal": {
        const member = this.memberInfo(message.from);
        if (!member) return;
        const payload = message.payload;
        if (payload.k === "candidate" && payload.candidate.candidate === "") {
          // pair-request wake (docs/02 §11.1 implementation note): a peer wants a
          // channel but is not the pair's offerer. If we are the offerer, attach;
          // an already connected pair would just see end-of-candidates, which the
          // answerer/offerer swallow harmlessly — so it is not forwarded.
          this.pairRequests.add(member.id);
          this.ensurePeer(member);
          this.maybeAttach(member.id);
          break;
        }
        await this.ensurePeer(member).handleSignal(payload);
        break;
      }
      case "member_left": {
        const peer = this.peers.get(message.memberId);
        peer?.close();
        this.peers.delete(message.memberId);
        store.removeMember(message.memberId);
        break;
      }
      case "room_closed": {
        this.roomClosed = true;
        store.patch({
          phase: "error",
          roomClosed: true,
          error:
            message.reason === "admin_close"
              ? copy.roomClosed
              : useApp.getState().sasPending
                ? "安全码没有确认，房间已结束。请重新扫码加入。"
                : copy.roomClosed,
        });
        break;
      }
      case "error": {
        if (message.code === "VERSION_MISMATCH") {
          store.patch({
            phase: "error",
            error: copy.versionOutdated,
            errorCode: message.code,
            versionOutdated: true,
          });
          return;
        }
        const lostRoom = this.reconnecting;
        this.reconnecting = false;
        if (
          lostRoom &&
          (message.code === "ROOM_CLOSED" || message.code === "ROOM_NOT_FOUND")
        )
          this.suppressAdminClose = true;
        store.patch({
          phase: "error",
          error: errorText(message.code, message.msg),
          errorCode: message.code,
          // Returning old admin / expired rejoin token: the room still exists, so
          // the UI offers the normal join flow instead of a dead end.
          ...(lostRoom &&
          (message.code === "ROOM_CLOSED" || message.code === "ROOM_NOT_FOUND")
            ? { rejoinLost: true }
            : {}),
        });
        break;
      }
      case "turn": {
        this.turn = {
          uris: message.uris,
          username: message.username,
          credential: message.credential,
          ttl: message.ttl,
        };
        for (const peer of this.peers.values()) peer.setTurn(this.turn);
        break;
      }
      default:
        break;
    }
  }

  // --- members and peers ----------------------------------------------------

  private applyMembers(members: MemberInfo[]): void {
    const store = useApp.getState();
    const previousAdmin = this.members.find((member) => member.isAdmin);
    this.members = members;
    store.setMembers(members);
    const self = members.find((member) => member.id === this.selfId);
    if (self) {
      this.selfName = self.name;
      store.patch({ selfName: self.name, selfId: self.id });
      // Admin hand-over (docs/02 §11.2): the role follows the broadcast, so the
      // admin-only controls appear/disappear without a page reload.
      const nextRole = roleAfterMembers(this.role, self.isAdmin);
      if (nextRole !== this.role) {
        this.role = nextRole;
        store.patch({ role: nextRole, hasKey: this.hasKey, link: this.link });
      }
    }
    const currentAdmin = members.find((member) => member.isAdmin);
    const handover = handoverInfo(previousAdmin, currentAdmin, this.selfId);
    if (handover) {
      const message =
        handover.kind === "promoted"
          ? copy.adminPromoted
          : tpl(copy.adminHandoverNotice, { name: handover.name });
      store.patch({ handoverNotice: message, notice: message });
    }
    for (const member of members) {
      if (member.id === this.selfId) continue;
      if (member.state === "offline") continue;
      const session = this.ensurePeer(member);
      // Phase-1 shaped pairs are still created eagerly: the 6-digit SAS
      // hand-over, and peers that run a phase-1 client (they only wait for the
      // admin's offer). Every phase-2 pair is lazy: a transfer or a wake
      // attaches it (docs/02 §11.1).
      this.maybeEagerAttach(member);
      this.maybeAttach(member.id);
      // A peer that comes back after a queued send may need the wake again.
      if (this.wantedPeers.has(member.id) && !session.hasHandles)
        this.wakePeer(member);
    }
    for (const peerId of [...this.peers.keys()]) {
      if (members.some((member) => member.id === peerId)) continue;
      this.dropPeer(peerId);
    }
    const others = members.filter(
      (member) => member.id !== this.selfId && member.state !== "offline",
    );
    const phase = store.phase;
    if (
      phase === "idle" ||
      phase === "provisioning" ||
      phase === "waiting" ||
      phase === "approval" ||
      phase === "joined"
    ) {
      store.patch({ phase: others.length > 0 ? "joined" : "waiting" });
    }
    if (this.fileList.length > 0 && others.length > 0) {
      const current = store.assignments;
      const next: Record<number, string[]> = {};
      for (const file of store.files) {
        const ids = new Set(current[file.id] ?? []);
        for (const member of others) ids.add(member.id);
        next[file.id] = [...ids];
      }
      store.setAssignments(next);
    }
  }

  private memberInfo(memberId: string): MemberInfo | undefined {
    return (
      this.members.find((member) => member.id === memberId) ??
      this.memberFromView(memberId)
    );
  }

  private memberFromView(memberId: string): MemberInfo | undefined {
    const view = useApp
      .getState()
      .members.find((member) => member.id === memberId);
    if (!view) return undefined;
    return {
      id: view.id,
      name: view.name,
      caps: view.caps,
      isAdmin: view.isAdmin,
      state: view.state === "offline" ? "offline" : "joined",
    };
  }

  /**
   * The pair's offerer election (docs/02 §11.1), evaluated against the live
   * member list: a role hand-over or a late caps broadcast can change the answer
   * for the next attach.
   */
  private isPairOfferer(peerId: string): boolean {
    const peer = this.memberInfo(peerId);
    return isPairOfferer({
      selfId: this.selfId,
      peerId,
      selfIsAdmin: this.role === "admin",
      peerIsAdmin: peer?.isAdmin ?? false,
      selfMesh: true,
      ...(peer ? { peerCaps: peer.caps } : {}),
      selfHasKey: this.hasKey,
      ...(this.memberHasKey.has(peerId)
        ? { peerHasKey: this.memberHasKey.get(peerId) }
        : {}),
    });
  }

  /** True while this pair still needs the 6-digit-code SAS hand-over. */
  private pairNeedsSas(peerId: string): boolean {
    return pairNeedsSas({
      selfHasKey: this.hasKey,
      ...(this.memberHasKey.has(peerId)
        ? { peerHasKey: this.memberHasKey.get(peerId) }
        : {}),
    });
  }

  /**
   * Whether the peer holds the roomKey. The admin always does (it is the source
   * of the key), and a `key-ok` proves it for everyone else.
   */
  private peerHasKey(peerId: string): boolean {
    const known = this.memberHasKey.get(peerId);
    if (known !== undefined) return known;
    return this.memberInfo(peerId)?.isAdmin === true && this.hasKey;
  }

  private ensurePeer(member: MemberInfo): PeerSession {
    const existing = this.peers.get(member.id);
    if (existing) return existing;
    const session = new PeerSession(member.id, this.peerHooks(member.id));
    this.peers.set(member.id, session);
    return session;
  }

  /**
   * Attach this pair if this side is its offerer and something wants it: a local
   * send (`wantedPeers`) or a pair-request wake from the peer (`pairRequests`).
   * Nothing is created on member join, and a PC is never pre-emptively offered
   * while the election is still unsettled (docs/02 §11.1 rule 3).
   */
  private maybeAttach(peerId: string): void {
    const peer = this.memberInfo(peerId);
    if (!peer || peer.state === "offline") return;
    if (!this.hasKey) return;
    if (this.pairNeedsSas(peerId)) return; // the SAS path attaches eagerly
    if (!pairElectionSettled(peer.caps)) return;
    if (!this.wantedPeers.has(peerId) && !this.pairRequests.has(peerId)) return;
    if (!this.isPairOfferer(peerId)) return;
    const session = this.peers.get(peerId);
    if (!session || session.hasHandles || session.connecting) return;
    session.attach();
  }

  /** Phase-1 pair shapes are still created eagerly by the admin. */
  private maybeEagerAttach(member: MemberInfo): void {
    if (this.role !== "admin" || !this.hasKey) return;
    if (member.state === "offline") return;
    const settled = pairElectionSettled(member.caps);
    const sas = this.pairNeedsSas(member.id);
    const legacy = settled && member.caps?.mesh !== true;
    if (!sas && !legacy) return;
    const session = this.ensurePeer(member);
    if (session.hasHandles || session.connecting) return;
    session.attach();
  }

  /**
   * Pair-request wake (docs/02 §11.1 implementation note): the answerer cannot
   * create a pair, so the first time it wants to send it asks the elected
   * offerer with an empty `candidate` signal — an existing, schema-valid payload
   * (trickle ICE end-of-candidates). Older clients ignore a candidate without a
   * live PC (`PeerSession.handleSignal` no-ops when `peer` is undefined), and an
   * already connected pair just drops the empty candidate in `addCandidate`.
   * Sent at most once per attach attempt; cleared when the pair opens or drops.
   */
  private wakePeer(member: MemberInfo): void {
    if (member.state === "offline") return;
    if (!this.hasKey) return;
    // The wake only means "create the pair"; whether the peer already holds the
    // roomKey is settled by the key-ok exchange on the opened channel, so it is
    // not required here (a keyless 6-digit member simply keeps the pair waiting).
    if (member.caps?.mesh !== true) return; // phase-1 peers get the admin's offer
    if (this.isPairOfferer(member.id)) return; // we attach ourselves
    const session = this.peers.get(member.id);
    if (!session || session.hasHandles || session.connecting) return;
    if (this.wakeSent.has(member.id)) return;
    this.wakeSent.add(member.id);
    this.socket.signal(member.id, {
      k: "candidate",
      candidate: { candidate: "" },
    });
  }

  private dropPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    peer?.close();
    this.peers.delete(peerId);
    this.retryFiles.delete(peerId);
    this.wantedPeers.delete(peerId);
    this.pairRequests.delete(peerId);
    this.wakeSent.delete(peerId);
    const timer = this.rebuildTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.rebuildTimers.delete(peerId);
    useApp.getState().clearTransfer(peerId);
  }

  private peerHooks(peerId: string): PeerSessionHooks {
    return {
      selfIsAdmin: () => this.role === "admin",
      peerIsAdmin: () => this.memberInfo(peerId)?.isAdmin ?? false,
      offerer: () => this.isPairOfferer(peerId),
      relayOnly: this.relayOnly,
      turn: this.turn,
      caps: () => this.caps,
      peerName: () => this.memberInfo(peerId)?.name ?? "对方",
      sessionKey: () => this.sessionKey,
      hasKey: () => this.hasKey,
      nativeShell: () => this.native,
      autoAccept: () => this.autoAccept,
      sendSignal: (payload: SignalPayload) =>
        this.socket.signal(peerId, payload),
      handleRoomCtrl: (message: CtrlMessage) =>
        this.handleRoomCtrl(peerId, message),
      onOpen: (handles: PeerHandles) => this.onPairOpen(peerId, handles),
      onLost: () => this.onPairLost(peerId),
      onPath: (path) => {
        useApp.getState().patchMember(peerId, { path });
        useApp.getState().patchTransfer(peerId, { path });
      },
      incoming: (view) => this.onIncoming(view),
      incomingAccepted: () => this.onIncomingAccepted(),
      incomingProgress: (receivedBytes, totalBytes) => {
        const startedAt =
          useApp.getState().transfers[peerId]?.startedAt ?? Date.now();
        const elapsed = (Date.now() - startedAt) / 1000;
        useApp.getState().patchTransfer(peerId, {
          sentBytes: receivedBytes,
          totalBytes,
          speedBps: elapsed > 0 ? receivedBytes / elapsed : 0,
        });
      },
      incomingFileDone: (result) => {
        useApp.getState().setResult(result);
      },
      incomingFinished: (result) => this.onIncomingFinished(peerId, result),
      incomingDeclined: () => {
        useApp.getState().setIncoming(undefined);
        useApp.getState().patch({ autoAcceptNotice: undefined });
        useApp.getState().patch({ notice: copy.decline });
      },
      incomingCancelled: (by) => this.onIncomingCancelled(peerId, by),
      outgoingStarted: (transferId, files, totalBytes) => {
        const path = useApp
          .getState()
          .members.find((member) => member.id === peerId)?.path;
        useApp.getState().setTransfer(peerId, {
          transferId,
          peerId,
          direction: "out",
          files,
          sentBytes: 0,
          totalBytes,
          startedAt: Date.now(),
          speedBps: 0,
          ...(path ? { path } : {}),
        });
        useApp.getState().patch({
          phase: "transferring",
          notice: undefined,
        });
        useApp.getState().patchMember(peerId, { state: "transferring" });
        void setTransferActive(true);
      },
      outgoingProgress: (sentBytes, totalBytes) => {
        const transfer = useApp.getState().transfers[peerId];
        const startedAt = transfer?.startedAt ?? Date.now();
        const elapsed = (Date.now() - startedAt) / 1000;
        useApp.getState().patchTransfer(peerId, {
          sentBytes,
          totalBytes,
          speedBps: elapsed > 0 ? sentBytes / elapsed : 0,
        });
        useApp.getState().patchMember(peerId, {
          progress: { sentBytes, totalBytes },
        });
      },
      outgoingPaused: (paused) => {
        useApp.getState().patch({
          notice: paused ? copy.busyRetry : copy.resumeHint,
        });
      },
      outgoingFinished: (outcome, files) =>
        this.onOutgoingFinished(peerId, outcome, files),
      queueChanged: (jobs) => {
        const entries: QueueView[] = jobs.map((job) => ({
          peerId,
          jobId: job.jobId,
          files: job.files,
          totalBytes: job.files.reduce((sum, file) => sum + file.size, 0),
        }));
        const others = useApp
          .getState()
          .queue.filter((entry) => entry.peerId !== peerId);
        useApp.getState().setQueue([...others, ...entries]);
      },
      failed: (message, code) => this.fail(message, code),
      confirmIncoming: (view) => this.confirmIncoming(view),
      nextTransferId: () => {
        this.transferCounter += 1;
        return `${this.selfId}:${this.transferCounter}`;
      },
    };
  }

  // --- peer events ----------------------------------------------------------

  private onPairOpen(peerId: string, handles: PeerHandles): void {
    const store = useApp.getState();
    const peer = this.peers.get(peerId);
    const member = this.memberInfo(peerId);
    // A pair opened: the wake marker did its job (a later drop re-arms it).
    this.wakeSent.delete(peerId);
    this.pairRequests.delete(peerId);
    if (this.role === "admin") {
      const claim = this.memberHasKey.get(peerId);
      if (claim === false) {
        // 6-digit path: the admin drives the SAS hand-over for this member.
        this.beginSas(peerId, handles);
      } else if (claim === undefined && member?.caps?.mesh !== true) {
        // Admin reconnect lost the join-request proof hint for a phase-1 peer:
        // give it a moment to announce key-ok, else fall back to the SAS ceremony.
        setTimeout(() => {
          const current = this.peers.get(peerId);
          if (!current?.hasHandles || this.sasPeerId === peerId) return;
          if (this.memberHasKey.get(peerId) === true) return;
          this.beginSas(peerId, handles);
        }, SAS_UNKNOWN_KEY_DELAY_MS);
      } else if (claim === true && this.hasKey) {
        peer?.setPairReady(true);
      }
    } else if (!this.hasKey) {
      // 6-digit path on the member side: SAS with the admin. A member↔member
      // pair never runs a second ceremony; it waits for the key and then
      // announces key-ok on every open pair.
      if (member?.isAdmin) this.beginSas(peerId, handles);
    } else if (this.peerHasKey(peerId)) {
      peer?.setPairReady(true);
    }
    if (store.phase === "waiting" && store.members.length > 1)
      store.patch({ phase: "joined" });
  }

  private onPairLost(peerId: string): void {
    const store = useApp.getState();
    if (store.phase === "transferring")
      store.patch({ phase: "paused", notice: copy.resumeHint });
    this.wakeSent.delete(peerId);
    // docs/02 §6.5: the pair's offerer rebuilds it; the answerer waits for the
    // fresh offer. Only pairs that were in use are rebuilt; an idle pair is
    // recreated on demand.
    if (!this.isPairOfferer(peerId)) return;
    if (this.rebuildTimers.has(peerId)) return;
    const timer = setTimeout(() => {
      this.rebuildTimers.delete(peerId);
      const peer = this.peers.get(peerId);
      if (!peer || peer.hasHandles || peer.connecting || this.intentionalClose)
        return;
      const member = this.memberInfo(peerId);
      if (!member || member.state === "offline") return;
      if (!this.wantedPeers.has(peerId) && !peer.busy) return;
      peer.attach();
    }, REBUILD_DELAY_MS);
    this.rebuildTimers.set(peerId, timer);
  }

  private beginSas(peerId: string, handles: PeerHandles): void {
    const sas = sasFromPeerConnection(handles.pc) ?? ["❓", "❓", "❓", "❓"];
    this.sasPeerId = peerId;
    this.sasConfirmedByMe = false;
    this.sasPeerConfirmed = false;
    this.sasTimer?.cancel();
    this.sasTimer = startTimeout(sasTimeoutMs(), () => this.failSas());
    useApp.getState().patch({
      sas,
      sasPending: true,
      sasConfirmedByMe: false,
    });
  }

  private failSas(): void {
    this.sasTimer = null;
    if (this.intentionalClose || this.roomClosed) return;
    useApp.getState().patch({
      phase: "error",
      error:
        "安全码确认超时（60 秒），已中止这次连接。请重新扫码，或让对方重新创建房间。",
    });
    this.close();
  }

  private handleRoomCtrl(peerId: string, message: CtrlMessage): boolean {
    switch (message.type) {
      case "sas-confirm":
        this.sasPeerConfirmed = true;
        this.maybeSendRoomKey(peerId);
        return true;
      case "key-ok": {
        // The peer proved it holds the roomKey. If we do too, the pair is ready
        // (no SAS ceremony between two members); if we are still on the 6-digit
        // path, only record it and wait for the admin's room-key.
        this.memberHasKey.set(peerId, true);
        if (!this.hasKey) return true;
        this.peers.get(peerId)?.setPairReady(true);
        // Only this pair's SAS card may be cleared: a key-ok from another member
        // must not cancel the 6-digit hand-over currently on screen.
        if (this.sasPeerId === undefined || this.sasPeerId === peerId)
          this.clearSasState();
        return true;
      }
      case "room-key": {
        if (this.role !== "member") return true;
        try {
          const roomKey = base64urlDecode(message.key);
          if (roomKey.length !== 32) return true;
          this.roomKey = roomKey;
          this.roomId = message.roomId;
          this.roomIdBytes = base32Decode(message.roomId);
          this.sessionKey = deriveSessionKey(roomKey, this.roomIdBytes);
          this.hasKey = true;
          const peer = this.peers.get(peerId);
          peer?.setPairReady(true);
          this.clearSasState();
          useApp.getState().patch({
            hasKey: true,
            roomId: this.roomId,
            link: this.link,
          });
          // A key gained here may also unlock member↔member pairs that were
          // opened (or asked for) while this device had no key: announce key-ok
          // everywhere and retry the stalled offers/wakes.
          this.announceKey();
          this.retryWantedPairs();
        } catch {
          // A malformed key must abort rather than leave a half-open room.
          this.fail("房间密钥格式不正确，请重新加入。");
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Clear the 6-digit-code SAS card once the key is exchanged. */
  private clearSasState(): void {
    this.sasTimer?.cancel();
    this.sasTimer = null;
    this.sasPeerId = undefined;
    this.sasConfirmedByMe = false;
    this.sasPeerConfirmed = false;
    useApp.getState().patch({
      sas: undefined,
      sasPending: false,
      sasConfirmedByMe: false,
    });
  }

  /**
   * A pair that was waiting for the roomKey is not attached/offered yet (the
   * offerer side had no key either). After the key arrives, retry the wanted
   * pairs: attach the ones this side offers, re-wake the ones the peer offers.
   */
  private retryWantedPairs(): void {
    for (const peerId of new Set([...this.wantedPeers, ...this.pairRequests])) {
      this.maybeAttach(peerId);
      const session = this.peers.get(peerId);
      if (session?.hasHandles || session?.connecting) continue;
      const member = this.memberInfo(peerId);
      if (!member || this.isPairOfferer(peerId)) continue;
      this.wakeSent.delete(peerId);
      this.wakePeer(member);
    }
  }

  /** Tell every open pair that this device holds the roomKey (idempotent). */
  private announceKey(): void {
    for (const [peerId, peer] of this.peers) {
      if (!peer.hasHandles) continue;
      peer.sendControl({ v: 2, type: "key-ok" });
      if (this.peerHasKey(peerId)) peer.setPairReady(true);
    }
  }

  private maybeSendRoomKey(peerId: string): void {
    if (this.role !== "admin" || this.keySent.has(peerId)) return;
    if (!this.sasConfirmedByMe || !this.sasPeerConfirmed) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.keySent.add(peerId);
    this.memberHasKey.set(peerId, true);
    peer.sendControl({
      v: 2,
      type: "room-key",
      key: base64urlEncode(this.roomKey),
      roomId: this.roomId,
    });
  }

  private patchSelfName(name: string): void {
    const store = useApp.getState();
    store.patch({ selfName: name });
    if (this.selfId) store.patchMember(this.selfId, { name });
  }

  // --- transfers ------------------------------------------------------------

  private confirmIncoming(view: IncomingView): Promise<boolean> {
    if (this.autoAccept) {
      this.pendingIncoming = view;
      return Promise.resolve(true);
    }
    useApp.getState().setIncoming(view);
    return new Promise((resolve) => {
      this.incomingResolver = resolve;
    });
  }

  private resolveIncoming(granted: boolean): void {
    const resolver = this.incomingResolver;
    this.incomingResolver = undefined;
    resolver?.(granted);
  }

  private onIncoming(view: IncomingView): void {
    this.pendingIncoming = view;
    if (this.autoAccept) {
      // Auto-accept (docs/02 §11.3) skips the consent card but must still be
      // visible: a toast announces it (it stays a few seconds even when the
      // transfer itself is faster than a frame) and the transfer card takes over.
      this.showAutoAcceptNotice(view.peerName);
      return;
    }
    useApp.getState().setIncoming(view);
  }

  private showAutoAcceptNotice(peerName: string): void {
    if (this.autoAcceptNoticeTimer) clearTimeout(this.autoAcceptNoticeTimer);
    useApp.getState().patch({
      autoAcceptNotice: tpl(copy.autoAcceptReceiving, { name: peerName }),
    });
    this.autoAcceptNoticeTimer = setTimeout(() => {
      this.autoAcceptNoticeTimer = undefined;
      useApp.getState().patch({ autoAcceptNotice: undefined });
    }, 4_000);
  }

  private onIncomingAccepted(): void {
    const store = useApp.getState();
    const incoming = store.incoming ?? this.pendingIncoming;
    this.pendingIncoming = undefined;
    if (!incoming) return;
    store.setIncoming(undefined);
    const path = store.members.find(
      (member) => member.id === incoming.peerId,
    )?.path;
    store.setTransfer(incoming.peerId, {
      transferId: incoming.transferId,
      peerId: incoming.peerId,
      direction: "in",
      files: incoming.files,
      sentBytes: 0,
      totalBytes: incoming.totalBytes,
      startedAt: Date.now(),
      speedBps: 0,
      ...(path ? { path } : {}),
    });
    store.patch({
      phase: "transferring",
      notice: undefined,
      incoming: undefined,
    });
    store.patchMember(incoming.peerId, { state: "transferring" });
    void setTransferActive(true);
  }

  private onIncomingFinished(peerId: string, result: ResultView): void {
    const store = useApp.getState();
    store.patchTransfer(peerId, { completed: true });
    store.setResult(result);
    store.patch({
      phase: "done",
      notice: `${copy.done} · ${formatBytes(result.bytes ?? 0)}`,
    });
    store.patchMember(peerId, { state: "done" });
    void setTransferActive(false);
  }

  /**
   * A user/peer cancel is a normal end (docs/02 §10.2): phase `cancelled` (no
   * error), the files are kept for 重试. A priority yield keeps the job queued.
   */
  private onIncomingCancelled(peerId: string, by: "local" | "peer"): void {
    const store = useApp.getState();
    this.resolveIncoming(false);
    this.pendingIncoming = undefined;
    store.setIncoming(undefined);
    store.patch({ autoAcceptNotice: undefined });
    store.patchTransfer(peerId, {
      cancelled: by === "peer" ? "peer" : "local",
    });
    store.patch({
      phase: "cancelled",
      notice: by === "peer" ? copy.cancelledByPeer : copy.cancelledLocal,
    });
    store.patchMember(peerId, { state: "joined" });
    void setTransferActive(false);
  }

  private onOutgoingFinished(
    peerId: string,
    outcome: SenderOutcome,
    files: File[],
  ): void {
    const store = useApp.getState();
    if (outcome.ok) {
      this.retryFiles.delete(peerId);
      store.patchTransfer(peerId, { completed: true });
      store.setResult({
        ok: true,
        ...(outcome.sha256 ? { sha256: outcome.sha256 } : {}),
        ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
      });
      store.patch({
        phase: "done",
        notice: `${copy.done} · ${formatBytes(outcome.bytes ?? 0)}`,
      });
      store.patchMember(peerId, { state: "done" });
      void setTransferActive(false);
      return;
    }
    if ("busy" in outcome && outcome.busy) {
      store.clearTransfer(peerId);
      store.patch({ notice: copy.busyRetry });
      return;
    }
    if ("cancelled" in outcome && outcome.cancelled) {
      if (outcome.by === "yield") {
        // Yielded the pair to a higher-priority peer transfer; the job stays
        // queued and starts again when the pair frees up.
        return;
      }
      this.retryFiles.set(peerId, files);
      store.patchTransfer(peerId, {
        cancelled: outcome.by === "peer" ? "peer" : "local",
        canRetry: true,
      });
      store.patch({
        phase: "cancelled",
        notice:
          outcome.by === "peer" ? copy.cancelledByPeer : copy.cancelledLocal,
        error: undefined,
        errorCode: undefined,
      });
      store.patchMember(peerId, { state: "joined" });
      void setTransferActive(false);
      return;
    }
    const error = "error" in outcome ? outcome.error : copy.errorGeneric;
    this.retryFiles.set(peerId, files);
    store.patchTransfer(peerId, {
      failed: true,
      canRetry: true,
      cancelled: undefined,
    });
    store.patch({ phase: "error", error });
    store.patchMember(peerId, { state: "joined" });
    void setTransferActive(false);
  }

  private fail(message: string, code?: string): void {
    if (this.intentionalClose) return;
    useApp.getState().patch({
      phase: "error",
      error: message,
      autoAcceptNotice: undefined,
      ...(code ? { errorCode: code } : {}),
    });
    void setTransferActive(false);
  }
}

function isTransferActive(): boolean {
  const state = useApp.getState();
  if (state.incoming) return true;
  if (state.phase === "transferring" || state.phase === "paused") return true;
  // A cancelled/failed card is a terminal report, not an active transfer.
  return Object.values(state.transfers).some(
    (transfer) => !transfer.cancelled && !transfer.failed,
  );
}

function detectCapsFallback(): Caps {
  return {
    platform: "unknown",
    uaFamily: "unknown",
    nativeShell: false,
    secureContext: false,
    fsAccess: false,
    sw: false,
    swDownload: false,
    saveStrategies: ["blob"],
    screen: "desktop",
  };
}

export function riskWarning(
  totalBytes: number,
  caps: Caps,
  softLimitMB: number,
): RiskView {
  const mb = Math.round(totalBytes / (1024 * 1024));
  return {
    level: "warn",
    message:
      caps.platform === "ios"
        ? `这台 iPhone 接收 ${mb} MB 风险较高。浏览器最多稳定保存约 ${softLimitMB} MB。建议改用电脑接收，或安装 CrossFile App。`
        : `这台设备接收 ${mb} MB 可能无法保存（稳定上限约 ${softLimitMB} MB）。可以继续，但建议改用电脑接收或安装 App。`,
    softLimitMB,
    hardLimitMB: 500,
    totalBytes,
  };
}
