import {
  ChunkReceiver,
  base32Decode,
  buildRoomLink,
  computeJoinProof,
  createGuestNonce,
  createGuestPeer,
  decodeChunkFrame,
  deriveFileKey,
  deriveSessionKey,
  detectCaps,
  iceServersFromTurn,
  importFileKey,
  parseCtrlMessage,
  sasFromPeerConnection,
  type Caps,
  type CtrlMessage,
  type FileManifestEntry,
  type Manifest,
  type Peer,
  type PeerHandles,
  type ClientMessage,
  type ServerMessage,
} from "@crossfile/core";
import { copy } from "@crossfile/ui";
import { SignalingSocket, withTimeout } from "./signal.js";
import { useApp } from "../store.js";

interface FileReceiver {
  entry: FileManifestEntry;
  receiver: ChunkReceiver;
  key: CryptoKey;
}

export class GuestController {
  private readonly caps: Caps = detectCaps();
  private readonly relayOnly = new URLSearchParams(location.search).get("relay") === "1";
  private readonly nonce = createGuestNonce();
  private readonly joinCode?: string;
  private codeMode = false;
  private sasConfirmedByMe = false;
  private readonly socket = new SignalingSocket();
  private peer?: Peer;
  private handles?: PeerHandles;
  private hostTurn?: Parameters<typeof iceServersFromTurn>[0];
  private peerDead = false;
  private manifest?: Manifest;
  private receivers = new Map<number, FileReceiver>();
  private roomId = "";
  private roomKey: Uint8Array = new Uint8Array(0);
  private roomIdBytes: Uint8Array = new Uint8Array(0);
  private sessionKey: Uint8Array = new Uint8Array(0);

  constructor(joinCode?: string) {
    this.joinCode = joinCode;
  }

  get link(): string {
    return this.roomId ? buildRoomLink(location.origin, this.roomId, this.roomKey) : "";
  }

  async start(): Promise<void> {
    const store = useApp.getState();
    store.reset({ role: "guest", phase: "provisioning" });
    if (this.joinCode) {
      // 6-digit-code path: no roomKey yet, it arrives after the SAS check.
      this.codeMode = true;
      this.roomId = this.joinCode;
      store.patch({ codeMode: true, hasKey: false });
    } else {
      const parsed = parseLocation();
      if (!parsed) {
        store.patch({ phase: "error", error: "链接不完整：缺少房间密钥（# 后的部分）" });
        return;
      }
      this.roomId = parsed.roomId;
      this.roomKey = parsed.roomKey;
      this.roomIdBytes = base32Decode(parsed.roomId);
      this.sessionKey = deriveSessionKey(this.roomKey, this.roomIdBytes);
      store.patch({ hasKey: true });
    }

    this.socket.onMessage((message) => void this.onMessage(message));
    this.socket.onClose(() => {
      const phase = useApp.getState().phase;
      // room_closed is delivered first (same socket); a host-initiated close already
      // produced a specific message, so don't overwrite it with the generic one.
      if (phase === "done" || phase === "error" || phase === "idle") return;
      useApp.getState().patch({ phase: "error", error: copy.connectionLost });
    });
    await this.socket.connect();
    this.socket.send({ v: 1, type: "hello", clientCaps: this.caps });
    this.socket.send({
      v: 1,
      type: "join",
      roomId: this.roomId,
      guestCaps: this.caps,
      guestNonce: this.nonce,
      ...(this.codeMode
        ? {}
        : { proof: computeJoinProof(this.roomKey, this.roomIdBytes, this.nonce) }),
    } as ClientMessage);
    store.patch({ phase: "waiting", roomId: this.roomId, link: this.link });
  }

  /** Guest side of the 4-emoji check; unlocks the roomKey hand-over. */
  confirmSas(): void {
    if (this.sasConfirmedByMe || !this.handles) return;
    this.sasConfirmedByMe = true;
    this.handles.ctrl.send(JSON.stringify({ v: 1, type: "sas-confirm" }));
    useApp.getState().patch({ sasConfirmedByMe: true });
  }

  accept(): void {
    if (!this.manifest || !this.handles) return;
    const store = useApp.getState();
    const totalBytes = this.manifest.files.reduce((sum, file) => sum + file.size, 0);
    this.handles.ctrl.send(
      JSON.stringify({ v: 1, type: "accept", fileIds: this.manifest.files.map((file) => file.id) }),
    );
    store.patch({ phase: "transferring" });
    store.setTransfer({ sentBytes: 0, totalBytes, startedAt: Date.now() });
  }

  close(): void {
    this.peer?.close();
    this.socket.close();
  }

  private async onMessage(message: ServerMessage): Promise<void> {
    const store = useApp.getState();
    switch (message.type) {
      case "join_ok": {
        store.patch({ hostCaps: message.peerCaps, phase: "joined" });
        this.hostTurn = message.turn;
        this.attachPeer(message.turn);
        break;
      }
      case "join_rejected": {
        store.patch({ phase: "error", error: `${message.code}: ${message.reason}` });
        break;
      }
      case "signal": {
        if (message.payload.k === "offer" && this.peerDead) {
          // Host re-offers after a channel drop (docs/02 §6.5): fresh PC, same receiver state.
          this.peerDead = false;
          this.attachPeer(this.hostTurn);
        }
        await this.peer?.handleSignal(message.payload);
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

  /** Creates the guest peer connection; re-used verbatim when the host re-offers. */
  private attachPeer(turn: Parameters<typeof iceServersFromTurn>[0]): void {
    this.hostTurn = turn;
    this.peer = createGuestPeer({
      iceServers: iceServersFromTurn(turn),
      relayOnly: this.relayOnly,
      sendSignal: (payload) => this.socket.signal("host", payload),
      onError: (error) => {
        console.debug("[cf-guest] peer error", String(error));
        this.markChannelLost();
      },
    });
    // `to: "host"` is a sentinel: the server routes guest signals to the room host.
    const peer = this.peer;
    peer.whenOpen
      .then((handles) => {
        if (this.peer !== peer) return; // superseded by a resume connection
        this.handles = handles;
        handles.ctrl.addEventListener("message", (event: MessageEvent) => this.onCtrl(event.data));
        handles.data.binaryType = "arraybuffer";
        handles.data.addEventListener("message", (event: MessageEvent) => void this.onData(event.data));
        handles.data.addEventListener("close", () => {
          if (this.peer === peer) this.markChannelLost();
        });
        handles.ctrl.addEventListener("close", () => {
          if (this.peer === peer) this.markChannelLost();
        });
        handles.ctrl.send(JSON.stringify({ v: 1, type: "hello", guestCaps: this.caps }));
        void handles.path().then((path) => useApp.getState().setTransfer({ path }));

        if (this.codeMode && this.sessionKey.length === 0) {
          const sas = sasFromPeerConnection(handles.pc);
          useApp.getState().patch({
            sas: sas ?? ["❓", "❓", "❓", "❓"],
            sasPending: true,
            sasConfirmedByMe: false,
          });
          return;
        }
        if (this.receivers.size > 0) this.requestResume();
      })
      .catch((error) => {
        console.debug("[cf-guest] peer open failed", String(error));
        if (this.peer === peer) this.markChannelLost();
      });
  }

  private markChannelLost(): void {
    this.peerDead = true;
    const store = useApp.getState();
    if (store.phase === "transferring") store.patch({ phase: "paused", notice: copy.resumeHint });
  }

  /** Tell the host what is still missing; only those chunks are re-sent (docs/02 §6.5). */
  private requestResume(): void {
    if (!this.handles) return;
    let asked = false;
    for (const [fileId, file] of this.receivers) {
      if (file.receiver.isComplete()) continue;
      asked = true;
      this.handles.ctrl.send(
        JSON.stringify({ v: 1, type: "bitmap", fileId, bits: file.receiver.bitmap() }),
      );
    }
    const store = useApp.getState();
    if (asked) store.patch({ phase: "transferring", notice: copy.resumeHint });
    else if (this.receivers.size > 0) store.patch({ phase: "done" });
  }

  private async onCtrl(raw: unknown): Promise<void> {
    let message: CtrlMessage;
    try {
      message = parseCtrlMessage(typeof raw === "string" ? JSON.parse(raw) : raw);
    } catch {
      return;
    }
    const store = useApp.getState();
    console.debug("[cf-guest] ctrl", message.type);
    switch (message.type) {
      case "manifest": {
        this.manifest = message;
        store.patch({
          phase: "joined",
          files: message.files.map((file) => ({ id: file.id, name: file.name, size: file.size, mime: file.mime })),
        });
        break;
      }
      case "room-key": {
        this.roomKey = base64urlToBytes(message.key);
        this.roomId = message.roomId;
        this.roomIdBytes = base32Decode(message.roomId);
        this.sessionKey = deriveSessionKey(this.roomKey, this.roomIdBytes);
        this.handles?.ctrl.send(JSON.stringify({ v: 1, type: "key-ok" }));
        useApp.getState().patch({ sas: undefined, sasPending: false, hasKey: true });
        break;
      }
      case "done": {
        await this.finishFile(message);
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

  private async finishFile(message: Extract<CtrlMessage, { type: "done" }>): Promise<void> {
    const store = useApp.getState();
    const file = this.receivers.get(message.fileId);
    if (!file || !this.handles) return;
    // `done` travels on the ctrl channel and can overtake the tail of the data
    // channel; wait until every chunk of this file has actually arrived.
    const deadline = Date.now() + 60_000;
    while (!file.receiver.isComplete() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const result = file.receiver.finish();
    const ok = result.complete && result.sha256 === message.sha256;
    console.debug("[cf-guest] verify", { ok, complete: result.complete, got: result.sha256.slice(0, 12) });
    this.handles.ctrl.send(JSON.stringify({ v: 1, type: "ack", fileId: message.fileId, ok }));

    if (!ok) {
      exposeTestState({ sha256: result.sha256, expected: message.sha256, size: result.size, complete: result.complete });
      store.patch({
        phase: "error",
        error: `${copy.verifyFailed} (${result.complete ? "hash" : "incomplete"} ${result.sha256.slice(0, 12)} ≠ ${message.sha256.slice(0, 12)})`,
        result: { ok: false, sha256: result.sha256, expected: message.sha256 },
      });
      return;
    }

    const bytes = file.receiver.collectBytes();
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: file.entry.mime });
    const url = URL.createObjectURL(blob);
    const totalBytes = this.manifest?.files.reduce((sum, entry) => sum + entry.size, 0) ?? bytes.length;
    store.patch({
      phase: "done",
      notice: copy.done,
      result: { ok: true, sha256: result.sha256, url, fileName: file.entry.name, bytes: bytes.length },
    });
    store.setTransfer({ sentBytes: totalBytes, totalBytes, speedBps: 0 });
    exposeTestState({ sha256: result.sha256, expected: message.sha256, size: bytes.length, complete: true });
  }

  private async onData(data: ArrayBuffer | string): Promise<void> {
    if (typeof data === "string" || !this.manifest) return;
    (globalThis as { __cfFrames?: number }).__cfFrames = ((globalThis as { __cfFrames?: number }).__cfFrames ?? 0) + 1;
    const frame = decodeChunkFrame(new Uint8Array(data));
    const entry = this.manifest.files.find((file) => file.id === frame.fileId);
    if (!entry) return;
    let file = this.receivers.get(frame.fileId);
    if (!file) {
      const salt = base64ToBytes(entry.salt);
      const key = await importFileKey(deriveFileKey(this.sessionKey, entry.id));
      const store = useApp.getState();
      const receiver = new ChunkReceiver({
        fileId: entry.id,
        size: entry.size,
        chunkSize: entry.chunk,
        chunkCount: entry.chunkCount,
        salt,
        key,
        progressEveryChunks: 10,
        onProgress: (receivedBytes) => {
          const startedAt = store.transfer?.startedAt ?? Date.now();
          const elapsed = (Date.now() - startedAt) / 1000;
          store.setTransfer({ sentBytes: receivedBytes, speedBps: elapsed > 0 ? receivedBytes / elapsed : 0 });
        },
      });
      file = { entry, receiver, key };
      this.receivers.set(frame.fileId, file);
    }
    await file.receiver.handleFrame(frame);
  }
}

function parseLocation(): { roomId: string; roomKey: Uint8Array } | null {
  const match = /^\/r\/([a-z2-7]+)\/?$/.exec(location.pathname);
  if (!match) return null;
  const roomId = match[1]!;
  const fragment = location.hash.replace(/^#/, "");
  if (!fragment) return null;
  try {
    const roomKey = base64urlToBytes(fragment);
    if (roomKey.length !== 32) return null;
    return { roomId, roomKey };
  } catch {
    return null;
  }
}

function base64urlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function base64ToBytes(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface TestState {
  sha256?: string;
  expected?: string;
  size?: number;
  complete?: boolean;
}

function exposeTestState(state: TestState): void {
  const target = globalThis as { __crossfile?: Record<string, unknown> };
  target.__crossfile = { ...(target.__crossfile ?? {}), ...state };
}
