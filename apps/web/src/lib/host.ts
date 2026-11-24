import {
  createFileSalt,
  createRoomIdentity,
  detectCaps,
  deriveFileKey,
  deriveSessionKey,
  effectiveChunkSize,
  importFileKey,
  parseCtrlMessage,
  sendFile,
  buildRoomLink,
  createHostPeer,
  iceServersFromTurn,
  type Caps,
  type CtrlMessage,
  type FileManifestEntry,
  type Manifest,
  type Peer,
  type PeerHandles,
  type ServerMessage,
  type TurnCredential,
} from "@crossfile/core";
import { copy, formatBytes } from "@crossfile/ui";
import { SignalingSocket, deferred, withTimeout } from "./signal.js";
import { useApp } from "../store.js";

interface PreparedFile {
  file: File;
  entry: FileManifestEntry;
}

interface GuestPeer {
  peer: Peer;
  handles?: PeerHandles;
  turn?: TurnCredential;
  prepared?: { files: PreparedFile[]; chunkSize: number };
  accept?: ReturnType<typeof deferred<number[]>>;
  acks: Map<number, ReturnType<typeof deferred<{ ok: boolean; error?: string }>>>;
  transferStarted?: boolean;
}

export class HostController {
  private readonly identity = createRoomIdentity();
  private readonly sessionKey = deriveSessionKey(this.identity.roomKey, this.identity.roomIdBytes);
  private readonly caps: Caps = detectCaps();
  private socket = new SignalingSocket();
  private readonly peers = new Map<string, GuestPeer>();
  private fileList: File[] = [];
  private heartbeat?: ReturnType<typeof setInterval>;
  private pathTimer?: ReturnType<typeof setTimeout>;

  get roomLink(): string {
    return buildRoomLink(location.origin, this.identity.roomId, this.identity.roomKey);
  }

  async start(): Promise<void> {
    useApp.getState().reset({ role: "host", phase: "provisioning" });
    this.socket.onMessage((message) => void this.onMessage(message));
    this.socket.onClose(() => useApp.getState().patch({ phase: "error", error: copy.connectionLost }));
    await this.socket.connect();
    this.socket.send({ v: 1, type: "hello", clientCaps: this.caps });
    this.socket.send({ v: 1, type: "create", roomId: this.identity.roomId, hostCaps: this.caps });
  }

  setFiles(files: File[]): void {
    this.fileList = files;
    useApp.getState().patch({
      files: files.map((file, index) => ({ id: index + 1, name: file.name, size: file.size, mime: file.type })),
    });
    for (const guest of this.peers.values()) {
      if (guest.handles) this.sendManifest(guest);
    }
  }

  approve(guestId: string): void {
    this.socket.send({ v: 1, type: "approve", guestId });
    useApp.getState().patchGuest(guestId, { status: "joined" });
  }

  deny(guestId: string): void {
    this.socket.send({ v: 1, type: "deny", guestId, reason: "host declined" });
    useApp.getState().removeGuest(guestId);
  }

  /** Explicit "start sending": make sure the manifest went out, then stream on accept. */
  async sendNow(): Promise<void> {
    const guestId = [...this.peers.keys()][0];
    if (!guestId) throw new Error(copy.emptyReceivers);
    const guest = this.peers.get(guestId)!;
    await withTimeout(guest.peer.whenOpen, 20_000, "peer not open");
    if (!guest.prepared) this.sendManifest(guest);
    this.startTransferOnce(guestId, guest);
  }

  private startTransferOnce(guestId: string, guest: GuestPeer): void {
    if (guest.transferStarted || !guest.accept) return;
    guest.transferStarted = true;
    void guest.accept.promise
      .then((fileIds) => this.transfer(guestId, fileIds))
      .catch((error: unknown) => useApp.getState().patch({ error: String(error) }));
  }

  close(): void {
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
        store.patch({
          phase: "waiting",
          roomId: this.identity.roomId,
          code: message.code,
          link: this.roomLink,
        });
        this.heartbeat = setInterval(
          () => this.socket.send({ v: 1, type: "heartbeat", roomId: this.identity.roomId }),
          20_000,
        );
        break;
      }
      case "join_request": {
        store.upsertGuest({ id: message.guestId, caps: message.guestCaps, status: "pending" });
        store.patch({ phase: "approval" });
        break;
      }
      case "join_ok": {
        store.upsertGuest({ id: message.guestId, caps: message.peerCaps, status: "joined" });
        store.patch({ phase: "joined" });
        this.openPeer(message.guestId, message.turn);
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
        store.patch({ phase: "error", error: `${message.code}: ${message.msg}` });
        break;
      }
      default:
        break;
    }
  }

  private openPeer(guestId: string, turn?: TurnCredential): void {
    const peer = createHostPeer({
      iceServers: iceServersFromTurn(turn),
      sendSignal: (payload) => this.socket.signal(guestId, payload),
      onError: (error) => {
        useApp.getState().patch({ error: String(error) });
      },
    });
    const guest: GuestPeer = { peer, turn, acks: new Map() };
    this.peers.set(guestId, guest);
    peer.whenOpen
      .then((handles) => {
        guest.handles = handles;
        handles.ctrl.addEventListener("message", (event: MessageEvent) => {
          this.onCtrl(guestId, event.data);
        });
        handles.data.binaryType = "arraybuffer";
        this.pathTimer = setTimeout(() => {
          void handles.path().then((path) => useApp.getState().patchGuest(guestId, { path }));
        }, 1_000);
        if (this.fileList.length > 0) this.sendManifest(guest);
      })
      .catch((error) => useApp.getState().patch({ error: String(error) }));
  }

  private sendManifest(guest: GuestPeer): void {
    if (!guest.handles) return;
    const maxMessageSize =
      (guest.handles.pc.sctp as { maxMessageSize?: number } | null)?.maxMessageSize ?? 262_144;
    const chunkSize = effectiveChunkSize(64 * 1024, maxMessageSize);
    const files: PreparedFile[] = this.fileList.map((file, index) => {
      const salt = createFileSalt();
      const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
      return {
        file,
        entry: {
          id: index + 1,
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          chunk: chunkSize,
          chunkCount,
          salt: bytesToBase64(salt),
        },
      };
    });
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
        this.startTransferOnce(guestId, guest);
        break;
      case "ack":
        guest.acks.get(message.fileId)?.resolve({ ok: message.ok, error: message.error });
        break;
      case "error":
        useApp.getState().patch({ error: `${message.code}: ${message.msg}` });
        break;
      default:
        break;
    }
  }

  private async transfer(guestId: string, acceptedIds: number[]): Promise<void> {
    const guest = this.peers.get(guestId);
    if (!guest?.handles || !guest.prepared) return;
    const store = useApp.getState();
    const totalBytes = guest.prepared.files
      .filter((f) => acceptedIds.includes(f.entry.id))
      .reduce((sum, f) => sum + f.file.size, 0);

    store.patch({ phase: "transferring" });
    store.patchGuest(guestId, { status: "transferring" });
    store.setTransfer({ sentBytes: 0, totalBytes, startedAt: Date.now(), path: store.guests.find((g) => g.id === guestId)?.path });
    let sentTotal = 0;
    let lastDigest = "";

    for (const prepared of guest.prepared.files) {
      if (!acceptedIds.includes(prepared.entry.id)) continue;
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
        onProgress: (sentBytes) => {
          const sent = sentTotal + sentBytes;
          const startedAt = useApp.getState().transfer?.startedAt ?? Date.now();
          const elapsed = (Date.now() - startedAt) / 1000;
          useApp.getState().setTransfer({ sentBytes: sent, speedBps: elapsed > 0 ? sent / elapsed : 0 });
        },
      });
      sentTotal += prepared.file.size;
      lastDigest = result.sha256;
      console.debug("[cf-host] sendFile resolved", { fileId, sha256: result.sha256.slice(0, 12), chunkCount: result.chunkCount });

      const ack = deferred<{ ok: boolean; error?: string }>();
      guest.acks.set(fileId, ack);
      console.debug("[cf-host] sending done", { fileId, state: guest.handles.ctrl.readyState });
      guest.handles.ctrl.send(
        JSON.stringify({ v: 1, type: "done", fileId, sha256: result.sha256, chunkCount: result.chunkCount }),
      );
      const outcome = await withTimeout(ack.promise, 120_000, "ack timeout");
      if (!outcome.ok) {
        store.patch({ phase: "error", error: outcome.error ?? copy.verifyFailed });
        return;
      }
    }

    store.patch({ phase: "done", result: { ok: true, sha256: lastDigest, bytes: totalBytes } });
    store.patchGuest(guestId, { status: "done", progress: { sentBytes: totalBytes, totalBytes } });
    store.patch({ notice: `${copy.done} · ${formatBytes(totalBytes)}` });
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
