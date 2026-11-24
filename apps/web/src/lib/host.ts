import {
  base64urlEncode,
  buildRoomLink,
  createFileSalt,
  createHostPeer,
  createRoomIdentity,
  decodeBitmap,
  deriveFileKey,
  deriveSessionKey,
  detectCaps,
  effectiveChunkSize,
  iceServersFromTurn,
  importFileKey,
  parseCtrlMessage,
  sasFromPeerConnection,
  sendFile,
  verifyJoinProof,
  wholeFileSha256,
  type Caps,
  type CtrlMessage,
  type FileManifestEntry,
  type Manifest,
  type Peer,
  type PeerHandles,
  type ServerMessage,
  type TurnCredential,
} from "@crossfile/core";
import { copy, errorText, formatBytes } from "@crossfile/ui";
import { installNativeShellHooks, setTransferActive } from "./native.js";
import { SignalingSocket, deferred, withTimeout } from "./signal.js";
import { useApp } from "../store.js";

interface PreparedFile {
  file: File;
  entry: FileManifestEntry;
  /** whole-file digest computed once; reused across resumes */
  sha256: string;
}

interface GuestPeer {
  peer: Peer;
  handles?: PeerHandles;
  turn?: TurnCredential;
  prepared?: { files: PreparedFile[]; chunkSize: number };
  accept?: ReturnType<typeof deferred<number[]>>;
  acks: Map<number, ReturnType<typeof deferred<{ ok: boolean; error?: string }>>>;
  transferStarted?: boolean;
  acceptedIds?: number[];
  nextFileIndex?: number;
  resuming?: boolean;
  reconnectScheduled?: boolean;
  /** QR path guests already hold the roomKey; code path guests get it after SAS. */
  hasKey: boolean;
  sasGuestConfirmed: boolean;
  sasHostConfirmed: boolean;
  keySent: boolean;
}

export class HostController {
  private readonly identity = createRoomIdentity();
  private readonly sessionKey = deriveSessionKey(this.identity.roomKey, this.identity.roomIdBytes);
  private readonly caps: Caps = detectCaps();
  private readonly relayOnly = new URLSearchParams(location.search).get("relay") === "1";
  private socket = new SignalingSocket();
  private readonly peers = new Map<string, GuestPeer>();
  private readonly guestNonces = new Map<string, string>();
  private readonly keyedGuests = new Set<string>();
  private fileList: File[] = [];
  private heartbeat?: ReturnType<typeof setInterval>;
  private pathTimer?: ReturnType<typeof setTimeout>;
  private cleanupNative?: () => void;
  /** Serialises guests: one transfer at a time (docs/01 D18). */
  private transferChain: Promise<void> = Promise.resolve();
  private sendArmed = false;

  get roomLink(): string {
    return buildRoomLink(location.origin, this.identity.roomId, this.identity.roomKey);
  }

  async start(): Promise<void> {
    useApp.getState().reset({ role: "host", phase: "provisioning" });
    this.socket.onMessage((message) => void this.onMessage(message));
    this.socket.onClose(() => {
      const phase = useApp.getState().phase;
      if (phase === "idle" || phase === "error") return;
      useApp.getState().patch({ phase: "error", error: copy.connectionLost });
    });
    await this.socket.connect();
    this.cleanupNative = installNativeShellHooks({
      isTransferActive: () => ["transferring", "paused"].includes(useApp.getState().phase),
      onEndRoom: () => this.close(),
      onNewRoom: () => location.assign("/"),
    });
    this.socket.send({ v: 1, type: "hello", clientCaps: this.caps });
    this.socket.send({ v: 1, type: "create", roomId: this.identity.roomId, hostCaps: this.caps });
  }

  setFiles(files: File[]): void {
    this.fileList = files;
    const store = useApp.getState();
    store.patch({
      files: files.map((file, index) => ({ id: index + 1, name: file.name, size: file.size, mime: file.type })),
    });
    // New files default to "send to every joined guest"; the matrix can override.
    const joined = this.joinedGuestIds();
    const assignments: Record<number, string[]> = {};
    for (let index = 0; index < files.length; index++) assignments[index + 1] = [...joined];
    store.setAssignments(assignments);
    this.refreshManifests();
  }

  /** File × guest matrix changed: re-issue manifests to guests that have not started. */
  refreshManifests(): void {
    for (const [guestId, guest] of this.peers) {
      if (guest.handles && !guest.transferStarted) void this.sendManifest(guestId, guest);
    }
  }

  private joinedGuestIds(): string[] {
    return [...this.peers.keys()];
  }

  private assignedFileIds(guestId: string): number[] {
    const { assignments } = useApp.getState();
    return this.fileList
      .map((_file, index) => index + 1)
      .filter((fileId) => (assignments[fileId] ?? []).includes(guestId));
  }

  approve(guestId: string): void {
    this.socket.send({ v: 1, type: "approve", guestId });
    useApp.getState().patchGuest(guestId, { status: "joined" });
  }

  /** Host removes an already-joined receiver (docs/02 §8: dropped immediately). */
  remove(guestId: string): void {
    this.socket.send({ v: 1, type: "remove", guestId });
    this.peers.get(guestId)?.peer.close();
    this.peers.delete(guestId);
    useApp.getState().patchGuest(guestId, { status: "removed" });
  }

  deny(guestId: string): void {
    this.socket.send({ v: 1, type: "deny", guestId, reason: "host declined" });
    useApp.getState().removeGuest(guestId);
  }

  /**
   * "开始发送": each guest gets its assigned files, one guest at a time
   * (docs/01 D18: sequential queue, never parallel).
   */
  async sendNow(): Promise<void> {
    const guestIds = this.joinedGuestIds().filter((guestId) => this.assignedFileIds(guestId).length > 0);
    if (guestIds.length === 0) throw new Error(copy.emptyReceivers);
    this.sendArmed = true;
    for (const guestId of guestIds) {
      const guest = this.peers.get(guestId)!;
      await withTimeout(guest.peer.whenOpen, 20_000, "peer not open");
      if (!guest.prepared) await this.sendManifest(guestId, guest);
      this.startTransferOnce(guestId, guest);
    }
  }

  /** Test/dev hook for AC3: kill the data path mid-transfer; the controller reconnects. */
  forceDrop(): void {
    const guestId = [...this.peers.keys()][0];
    if (!guestId) return;
    const guest = this.peers.get(guestId)!;
    guest.peer.close();
    guest.handles = undefined;
    useApp.getState().patch({ phase: "paused", notice: copy.resumeHint });
    this.scheduleReconnect(guestId);
  }

  close(): void {
    this.cleanupNative?.();
    void setTransferActive(false);
    this.socket.send({ v: 1, type: "close", roomId: this.identity.roomId });
    for (const guest of this.peers.values()) guest.peer.close();
    this.peers.clear();
    this.socket.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pathTimer) clearTimeout(this.pathTimer);
    useApp.getState().patch({ phase: "idle", guests: [], files: [] });
  }

  private async onMessage(message: ServerMessage): Promise<void> {
    const store = useApp.getState();
    switch (message.type) {
      case "created": {
        store.patch({ phase: "waiting", roomId: this.identity.roomId, code: message.code, link: this.roomLink });
        this.heartbeat = setInterval(
          () => this.socket.send({ v: 1, type: "heartbeat", roomId: this.identity.roomId }),
          20_000,
        );
        break;
      }
      case "join_request": {
        const hasProof = message.proof !== undefined;
        if (hasProof && !verifyJoinProof(this.identity.roomKey, this.identity.roomIdBytes, message.guestNonce, message.proof)) {
          // A signaling server that does not know roomKey cannot forge this proof (docs/02 §2.3).
          this.socket.send({ v: 1, type: "deny", guestId: message.guestId, reason: "PROOF_INVALID" });
          break;
        }
        this.guestNonces.set(message.guestId, message.guestNonce);
        if (hasProof) this.keyedGuests.add(message.guestId);
        store.upsertGuest({ id: message.guestId, caps: message.guestCaps, status: "pending" });
        store.patch({ phase: "approval" });
        break;
      }
      case "join_ok": {
        store.upsertGuest({ id: message.guestId, caps: message.peerCaps, status: "joined" });
        const assignments = { ...store.assignments };
        for (const file of store.files) {
          const current = assignments[file.id] ?? [];
          assignments[file.id] = current.includes(message.guestId) ? current : [...current, message.guestId];
        }
        store.setAssignments(assignments);
        store.patch({ phase: "joined" });
        this.openPeer(message.guestId, message.turn, this.guestHasKey(message.guestId));
        break;
      }
      case "signal": {
        await this.peers.get(message.from)?.peer.handleSignal(message.payload);
        break;
      }
      case "peer_left": {
        store.patchGuest(message.guestId, { status: "removed" });
        store.patch({ phase: store.guests.length > 0 ? "joined" : "waiting" });
        this.peers.get(message.guestId)?.peer.close();
        this.peers.delete(message.guestId);
        break;
      }
      case "room_closed": {
        store.patch({ phase: "error", roomClosed: true, error: copy.roomClosed });
        break;
      }
      case "error": {
        store.patch({ phase: "error", error: errorText(message.code, message.msg) });
        break;
      }
      default:
        break;
    }
  }

  private guestHasKey(guestId: string): boolean {
    return this.keyedGuests.has(guestId);
  }

  private openPeer(guestId: string, turn: TurnCredential | undefined, hasKey: boolean): void {
    const guest: GuestPeer = {
      peer: undefined as unknown as Peer,
      turn,
      acks: new Map(),
      hasKey,
      sasGuestConfirmed: false,
      sasHostConfirmed: false,
      keySent: false,
    };
    this.peers.set(guestId, guest);
    this.attachPeer(guestId, guest, false);
  }

  /** Creates a fresh RTCPeerConnection for a guest; also used for resume (docs/02 §6.5). */
  private attachPeer(guestId: string, guest: GuestPeer, resume: boolean): void {
    const peer = createHostPeer({
      iceServers: iceServersFromTurn(guest.turn),
      relayOnly: this.relayOnly,
      sendSignal: (payload) => this.socket.signal(guestId, payload),
      onError: (error) => {
        console.debug("[cf-host] peer error", String(error));
        this.onChannelLost(guestId, guest);
      },
    });
    guest.peer = peer;
    if (resume) guest.resuming = true;

    peer.whenOpen
      .then((handles) => {
        if (guest.peer !== peer) return; // a newer connection superseded this one
        guest.handles = handles;
        handles.ctrl.addEventListener("message", (event: MessageEvent) => this.onCtrl(guestId, event.data));
        handles.data.binaryType = "arraybuffer";
        handles.data.addEventListener("close", () => {
          if (guest.peer === peer) this.onChannelLost(guestId, guest);
        });
        handles.ctrl.addEventListener("close", () => {
          if (guest.peer === peer) this.onChannelLost(guestId, guest);
        });
        this.pathTimer = setTimeout(() => {
          void handles.path().then((path) => useApp.getState().patchGuest(guestId, { path }));
        }, 1_000);

        if (guest.resuming) {
          // Channels are back: the guest will send a bitmap of what it still misses.
          guest.resuming = false;
          useApp.getState().patch({ phase: "paused", notice: copy.resumeHint });
          return;
        }
        if (guest.hasKey) {
          if (this.fileList.length > 0) void this.sendManifest(guestId, guest);
        } else {
          const sas = sasFromPeerConnection(handles.pc);
          useApp.getState().patch({
            sas: sas ?? ["❓", "❓", "❓", "❓"],
            sasPending: true,
            sasConfirmedByMe: false,
          });
        }
      })
      .catch((error) => {
        console.debug("[cf-host] peer open failed", String(error));
        if (guest.peer === peer) this.onChannelLost(guestId, guest);
      });
  }

  private onChannelLost(guestId: string, guest: GuestPeer): void {
    guest.handles = undefined;
    if (!guest.transferStarted) return;
    const store = useApp.getState();
    if (store.phase === "transferring") store.patch({ phase: "paused", notice: copy.resumeHint });
    this.scheduleReconnect(guestId);
  }

  private scheduleReconnect(guestId: string): void {
    const guest = this.peers.get(guestId);
    if (!guest || guest.reconnectScheduled) return;
    guest.reconnectScheduled = true;
    setTimeout(() => {
      const current = this.peers.get(guestId);
      if (!current) return;
      current.reconnectScheduled = false;
      if (current.handles) return;
      console.debug("[cf-host] reconnecting guest", guestId);
      this.attachPeer(guestId, current, true);
    }, 500);
  }

  private async sendManifest(guestId: string, guest: GuestPeer): Promise<void> {
    if (!guest.handles) return;
    const maxMessageSize =
      (guest.handles.pc.sctp as { maxMessageSize?: number } | null)?.maxMessageSize ?? 262_144;
    const chunkSize = effectiveChunkSize(64 * 1024, maxMessageSize);
    const assigned = new Set(this.assignedFileIds(guestId));
    const files: PreparedFile[] = await Promise.all(
      this.fileList
        .map((file, index) => ({ file, fileId: index + 1 }))
        .filter((entry) => assigned.has(entry.fileId))
        .map(async ({ file, fileId }) => {
          const salt = createFileSalt();
          const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
          return {
            file,
            sha256: await wholeFileSha256(file, chunkSize),
            entry: {
              id: fileId,
              name: file.name,
              size: file.size,
              mime: file.type || "application/octet-stream",
              chunk: chunkSize,
              chunkCount,
              salt: bytesToBase64(salt),
            },
          };
        }),
    );
    if (files.length === 0) return;
    const manifest: Manifest = {
      v: 1,
      type: "manifest",
      files: files.map((f) => f.entry),
      totalSize: files.reduce((sum, f) => sum + f.file.size, 0),
      chunkNegotiation: { min: 64 * 1024, max: 256 * 1024 },
    };
    guest.prepared = { files, chunkSize };
    guest.accept = deferred<number[]>();
    guest.handles.ctrl.send(JSON.stringify(manifest));
  }

  private onCtrl(guestId: string, raw: unknown): void {
    let message: CtrlMessage;
    try {
      message = parseCtrlMessage(typeof raw === "string" ? JSON.parse(raw) : raw);
    } catch {
      return;
    }
    const guest = this.peers.get(guestId);
    if (!guest) return;
    switch (message.type) {
      case "accept":
        guest.accept?.resolve(message.fileIds);
        guest.acceptedIds = message.fileIds;
        // A guest accepting the manifest is itself the go-ahead: queue the transfer even
        // if the host did not press "开始发送" (the manifest was already an intent to send).
        this.sendArmed = true;
        this.startTransferOnce(guestId, guest);
        break;
      case "ack":
        guest.acks.get(message.fileId)?.resolve({ ok: message.ok, error: message.error });
        break;
      case "bitmap": {
        // Resume: only the missing chunks of this file are re-sent (docs/02 §6.5).
        const prepared = guest.prepared?.files.find((file) => file.entry.id === message.fileId);
        if (!prepared || !guest.handles) return;
        const missing = [...Array(prepared.entry.chunkCount).keys()].filter(
          (seq) => !decodeBitmap(message.bits, prepared.entry.chunkCount).has(seq),
        );
        console.debug("[cf-host] resume bitmap", { fileId: message.fileId, missing: missing.length });
        void this.sendPrepared(guestId, guest, prepared, missing)
          .then(() => {
            guest.nextFileIndex = (guest.nextFileIndex ?? 0) + 1;
            return this.runTransfer(guestId);
          })
          .catch((error: unknown) => {
            console.debug("[cf-host] resume failed", String(error));
            this.onChannelLost(guestId, guest);
          });
        break;
      }
      case "sas-confirm":
        guest.sasGuestConfirmed = true;
        this.maybeSendRoomKey(guestId, guest);
        break;
      case "key-ok":
        useApp.getState().patch({ sas: undefined, sasPending: false, sasConfirmedByMe: false });
        useApp.getState().patchGuest(guestId, { status: "joined" });
        if (this.fileList.length > 0) void this.sendManifest(guestId, guest);
        this.startTransferOnce(guestId, guest);
        break;
      case "error":
        useApp.getState().patch({ error: errorText(message.code, message.msg) });
        break;
      default:
        break;
    }
  }

  /** Host side of the 4-emoji check (docs/02 §3.5). Defaults to the first guest. */
  confirmSas(guestId?: string): void {
    const id = guestId ?? [...this.peers.keys()][0];
    if (!id) return;
    const guest = this.peers.get(id);
    if (!guest) return;
    guest.sasHostConfirmed = true;
    useApp.getState().patch({ sasConfirmedByMe: true });
    this.maybeSendRoomKey(id, guest);
  }

  private maybeSendRoomKey(guestId: string, guest: GuestPeer): void {
    if (guest.hasKey || guest.keySent) return;
    if (!guest.sasHostConfirmed || !guest.sasGuestConfirmed) return;
    if (!guest.handles) return;
    guest.keySent = true;
    guest.handles.ctrl.send(
      JSON.stringify({ v: 1, type: "room-key", key: base64urlEncode(this.identity.roomKey), roomId: this.identity.roomId }),
    );
    useApp.getState().patch({ sasPending: false });
  }

  private startTransferOnce(guestId: string, guest: GuestPeer): void {
    if (guest.transferStarted || !guest.accept) return;
    guest.transferStarted = true;
    const accept = guest.accept.promise;
    this.transferChain = this.transferChain
      .then(async () => {
        guest.acceptedIds = await accept;
        await this.runTransfer(guestId);
      })
      .catch((error: unknown) => {
        console.debug("[cf-host] queued transfer failed", String(error));
        useApp.getState().patch({ error: String(error) });
      });
  }

  private async runTransfer(guestId: string): Promise<void> {
    const guest = this.peers.get(guestId);
    if (!guest?.prepared) return;
    const accepted = guest.prepared.files.filter(
      (file) => guest.acceptedIds?.includes(file.entry.id) && this.assignedFileIds(guestId).includes(file.entry.id),
    );
    const store = useApp.getState();
    const totalBytes = accepted.reduce((sum, file) => sum + file.file.size, 0);

    if ((guest.nextFileIndex ?? 0) === 0) {
      void setTransferActive(true);
      store.patch({ phase: "transferring", notice: undefined });
      store.patchGuest(guestId, { status: "transferring" });
      store.setTransfer({
        sentBytes: 0,
        totalBytes,
        startedAt: Date.now(),
        path: store.guests.find((entry) => entry.id === guestId)?.path,
      });
    }

    for (let index = guest.nextFileIndex ?? 0; index < accepted.length; index++) {
      if (!guest.handles) {
        // Channel dropped: wait for the bitmap-driven resume (close guard stays on).
        store.patch({ phase: "paused", notice: copy.resumeHint });
        return;
      }
      const prepared = accepted[index]!;
      guest.nextFileIndex = index;
      try {
        await this.sendPrepared(guestId, guest, prepared);
      } catch (error) {
        console.debug("[cf-host] send failed, waiting for resume", String(error));
        this.onChannelLost(guestId, guest);
        return;
      }
      guest.nextFileIndex = index + 1;
    }

    const last = accepted[accepted.length - 1];
    void setTransferActive(false);
    store.patch({ phase: "done", result: { ok: true, sha256: last?.sha256, bytes: totalBytes } });
    store.patchGuest(guestId, { status: "done", progress: { sentBytes: totalBytes, totalBytes } });
    store.patch({ notice: `${copy.done} · ${formatBytes(totalBytes)}` });
  }

  private async sendPrepared(
    guestId: string,
    guest: GuestPeer,
    prepared: PreparedFile,
    onlyChunks?: number[],
  ): Promise<void> {
    if (!guest.handles || !guest.prepared) throw new Error("channel closed");
    const fileId = prepared.entry.id;
    const salt = base64ToBytes(prepared.entry.salt);
    const key = await importFileKey(deriveFileKey(this.sessionKey, fileId));
    const result = await sendFile({
      fileId,
      file: prepared.file,
      chunkSize: guest.prepared.chunkSize,
      salt,
      key,
      channel: guest.handles.data,
      onlyChunks,
      computeHash: false,
      onProgress: (sentBytes) => {
        const startedAt = useApp.getState().transfer?.startedAt ?? Date.now();
        const elapsed = (Date.now() - startedAt) / 1000;
        useApp.getState().setTransfer({ sentBytes, speedBps: elapsed > 0 ? sentBytes / elapsed : 0 });
      },
    });
    console.debug("[cf-host] chunks sent", { fileId, only: onlyChunks?.length ?? result.chunkCount, sha256: prepared.sha256.slice(0, 12) });

    const ack = deferred<{ ok: boolean; error?: string }>();
    guest.acks.set(fileId, ack);
    guest.handles.ctrl.send(
      JSON.stringify({ v: 1, type: "done", fileId, sha256: prepared.sha256, chunkCount: result.chunkCount }),
    );
    const outcome = await withTimeout(ack.promise, 120_000, "ack timeout");
    if (!outcome.ok) {
      useApp.getState().patch({ phase: "error", error: outcome.error ?? copy.verifyFailed });
      throw new Error(outcome.error ?? copy.verifyFailed);
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
