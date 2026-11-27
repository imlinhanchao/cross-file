/**
 * One `PeerConnection` per pair of members (ADR 0010, docs/02 v2).
 *
 * Responsibilities:
 * - own the WebRTC peer (phase 1: the admin is always the offerer),
 * - serialise transfers with that peer: at most one active transfer per pair,
 *   either direction; a local attempt while the pair is busy is queued and
 *   retried when the pair becomes idle (AC11),
 * - bus routing: control frames go to the active transfer or to the room-level
 *   handler; data frames go to the active receiver,
 * - survive a broken channel: the sender waits for the rebuilt channel and the
 *   receiver re-announces its bitmap (docs/02 §6.5).
 */
import {
  coerceBytes,
  createAnswererPeer,
  createOffererPeer,
  decodeChunkFrame,
  iceServersFromTurn,
  parseCtrlMessage,
  type Caps,
  type CtrlMessage,
  type Manifest,
  type PathLabel,
  type Peer,
  type PeerHandles,
  type SignalPayload,
  type TurnCredential,
} from "@crossfile/core";
import { SenderTransfer, type SenderOutcome } from "./send.js";
import { ReceiverTransfer } from "./receive.js";
import type { FileView, IncomingView, ResultView } from "../store.js";

export interface PeerSessionHooks {
  selfIsAdmin: boolean;
  peerIsAdmin: boolean;
  /** phase 1: the admin side creates the offer and the data channels */
  offerer: boolean;
  relayOnly: boolean;
  turn?: TurnCredential;
  caps(): Caps;
  peerName(): string;
  sessionKey(): Uint8Array;
  /** this device already holds the roomKey (QR path, or after the SAS hand-over) */
  hasKey(): boolean;
  nativeShell(): boolean;
  autoAccept(): boolean;
  sendSignal(payload: SignalPayload): void;
  /** ctrl messages that belong to the room, not to a transfer (hello/key-ok/sas-confirm/room-key) */
  handleRoomCtrl(message: CtrlMessage): boolean;
  onOpen(handles: PeerHandles): void;
  onLost(): void;
  onPath(path: PathLabel): void;
  /** a manifest from this peer needs the user's consent */
  incoming(view: IncomingView): void;
  incomingAccepted(): void;
  incomingProgress(receivedBytes: number, totalBytes: number): void;
  incomingFileDone(result: ResultView): void;
  incomingFinished(result: ResultView): void;
  incomingDeclined(reason: string): void;
  outgoingStarted(
    transferId: string,
    files: FileView[],
    totalBytes: number,
  ): void;
  outgoingProgress(sentBytes: number, totalBytes: number): void;
  outgoingPaused(paused: boolean): void;
  outgoingFinished(outcome: SenderOutcome): void;
  /** queue for this pair changed (for the UI) */
  queueChanged(jobs: FileView[][], busy: boolean): void;
  failed(message: string, code?: string): void;
  confirmIncoming(view: IncomingView): Promise<boolean>;
  /** `${selfId}:${counter}` — monotonic, unique per sender per session */
  nextTransferId(): string;
}

const REBUILD_RETRY_MS = 800;

export class PeerSession {
  readonly peerId: string;
  private readonly hooks: PeerSessionHooks;
  private peer?: Peer;
  private handles?: PeerHandles;
  private sender?: SenderTransfer;
  private receiver?: ReceiverTransfer;
  private readonly outQueue: File[][] = [];
  /** data frames are ordered on the wire; process them strictly in order too */
  private dataChain: Promise<void> = Promise.resolve();
  private openWaiters: Array<{
    resolve(handles: PeerHandles): void;
    reject(error: Error): void;
  }> = [];
  private pumping = false;
  private closed = false;
  private pairReady = false;
  private requeueOnCancel = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(peerId: string, hooks: PeerSessionHooks) {
    this.peerId = peerId;
    this.hooks = hooks;
  }

  get busy(): boolean {
    return this.sender !== undefined || this.receiver !== undefined;
  }

  get hasHandles(): boolean {
    return this.handles !== undefined;
  }

  get queuedCount(): number {
    return this.outQueue.length + (this.sender ? 1 : 0);
  }

  /** Create a fresh peer connection (also used after a channel drop). */
  attach(): void {
    if (this.closed) return;
    this.disposePeer();
    const options = {
      iceServers: iceServersFromTurn(this.hooks.turn),
      relayOnly: this.hooks.relayOnly,
      sendSignal: (payload: SignalPayload) => this.hooks.sendSignal(payload),
      onError: (error: unknown) => {
        console.debug("[cf-pair] peer error", String(error));
        this.handleLost();
      },
    };
    const peer = this.hooks.offerer
      ? createOffererPeer(options)
      : createAnswererPeer(options);
    this.peer = peer;
    peer.whenOpen
      .then((handles) => {
        if (this.peer !== peer) return; // superseded by a rebuild
        this.installHandles(handles);
      })
      .catch((error: unknown) => {
        console.debug("[cf-pair] peer open failed", String(error));
        if (this.peer === peer) this.handleLost();
      });
  }

  async handleSignal(payload: SignalPayload): Promise<void> {
    if (this.closed) return;
    if (payload.k === "offer" && !this.hooks.offerer) {
      // The admin rebuilds the pair after a drop: always start a fresh answerer. The
      // old connection may still look alive because its close event is delivered late
      // (Chrome timing differs across machines); reusing it would apply the new offer
      // to a dead channel and leave the sender stuck.
      if (this.peer) this.handleLost();
      this.attach();
    }
    await this.peer?.handleSignal(payload);
  }

  /** Send one ctrl message to the peer (room-level handshake). */
  sendControl(message: CtrlMessage): void {
    this.sendCtrl(message);
  }

  /** Queue files for this pair; starts as soon as the pair is idle and ready. */
  enqueue(files: File[]): void {
    if (this.closed || files.length === 0) return;
    this.outQueue.push(files);
    this.notifyQueue();
    void this.pump();
  }

  setPairReady(ready: boolean): void {
    this.pairReady = ready;
    if (ready) void this.pump();
  }

  setTurn(turn: TurnCredential | undefined): void {
    this.hooks.turn = turn;
  }

  /** The rebuilt channels are usable; resume whatever was in flight. */
  onReopen(): void {
    const handles = this.handles;
    if (!handles) return;
    this.receiver?.onReopen();
    this.sender?.onReopen();
    void this.pump();
  }

  close(): void {
    this.closed = true;
    this.sender?.cancel();
    this.receiver?.close();
    this.sender = undefined;
    this.receiver = undefined;
    this.outQueue.length = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.disposePeer();
    for (const waiter of this.openWaiters.splice(0))
      waiter.reject(new Error("pair closed"));
  }

  /**
   * AC12 test hook: kill the channel. The admin-side owner (RoomController)
   * schedules the rebuild, so this must not attach a second peer itself.
   */
  forceDrop(): void {
    this.handleLost();
  }

  private installHandles(handles: PeerHandles): void {
    this.handles = handles;
    handles.data.binaryType = "arraybuffer";
    handles.ctrl.addEventListener("message", (event: MessageEvent) =>
      this.onCtrl(event.data),
    );
    handles.data.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as ArrayBuffer | string;
      if (typeof data === "string") return;
      this.onData(data);
    });
    const lost = (): void => {
      if (this.handles === handles) this.handleLost();
    };
    handles.ctrl.addEventListener("close", lost);
    handles.data.addEventListener("close", lost);
    this.hooks.onOpen(handles);
    for (const waiter of this.openWaiters.splice(0)) waiter.resolve(handles);
    void handles.path().then((path) => this.hooks.onPath(path));
    // ctrl hello announces our capabilities; the receiving side already knows
    // them from the member list, so this is informational only.
    this.sendCtrl({ v: 2, type: "hello", caps: this.hooks.caps() });
    if (!this.hooks.offerer && this.hooks.hasKey()) {
      // QR path (and any later rebuild): tell the admin we are ready to receive
      // and send. On the 6-digit path this is sent after the key hand-over.
      this.sendCtrl({ v: 2, type: "key-ok" });
    }
    this.setPairReady(
      this.hooks.offerer ? this.pairReady : this.hooks.hasKey(),
    );
    this.onReopen();
  }

  private handleLost(): void {
    if (this.closed || !this.handles) {
      this.disposePeer();
      return;
    }
    this.handles = undefined;
    this.disposePeer();
    this.sender?.onLost();
    this.receiver?.onLost();
    this.hooks.onLost();
  }

  private disposePeer(): void {
    this.peer?.close();
    this.peer = undefined;
    this.handles = undefined;
  }

  private async pump(): Promise<void> {
    if (this.closed || this.pumping || this.busy) return;
    if (!this.pairReady || this.hooks.sessionKey().length === 0) {
      this.notifyQueue();
      return;
    }
    if (this.outQueue.length === 0) {
      this.notifyQueue();
      return;
    }
    this.pumping = true;
    try {
      const files = this.outQueue[0]!;
      const transfer = new SenderTransfer({
        transferId: this.hooks.nextTransferId(),
        files,
        sessionKey: this.hooks.sessionKey(),
        getHandles: () => this.handles,
        callbacks: {
          started: (transferId, views, totalBytes) =>
            this.hooks.outgoingStarted(transferId, views, totalBytes),
          progress: (transferId, sentBytes, totalBytes) =>
            this.hooks.outgoingProgress(sentBytes, totalBytes),
          paused: (_transferId, paused) => this.hooks.outgoingPaused(paused),
        },
      });
      this.sender = transfer;
      const outcome = await transfer.run();
      this.sender = undefined;
      if (outcome.ok) {
        this.outQueue.shift();
        this.hooks.outgoingFinished(outcome);
      } else if ("busy" in outcome && outcome.busy) {
        // The pair is busy on the other direction: retry when it frees up.
        this.hooks.outgoingFinished(outcome);
        this.scheduleRetry();
        this.notifyQueue();
        return;
      } else if ("cancelled" in outcome && outcome.cancelled) {
        if (this.requeueOnCancel) {
          // We yielded to the admin's transfer; our job waits at the head.
          this.requeueOnCancel = false;
          this.hooks.outgoingFinished(outcome);
        } else {
          this.outQueue.shift();
          this.hooks.outgoingFinished(outcome);
        }
      } else {
        this.outQueue.shift();
        this.hooks.outgoingFinished(outcome);
      }
      this.notifyQueue();
    } finally {
      this.pumping = false;
    }
    if (!this.busy && this.outQueue.length > 0) await this.pump();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.pump();
    }, REBUILD_RETRY_MS);
  }

  private notifyQueue(): void {
    this.hooks.queueChanged(
      this.outQueue.map((files) =>
        files.map((file, index) => ({
          id: index + 1,
          name: file.name,
          size: file.size,
          mime: file.type,
        })),
      ),
      this.busy,
    );
  }

  private onCtrl(raw: unknown): void {
    if (this.closed) return;
    let message: CtrlMessage;
    try {
      message = parseCtrlMessage(
        typeof raw === "string" ? JSON.parse(raw) : raw,
      );
    } catch {
      return;
    }
    switch (message.type) {
      case "manifest":
        this.onManifest(message);
        return;
      case "hello":
        return;
      case "key-ok":
      case "sas-confirm":
      case "room-key":
        if (this.hooks.handleRoomCtrl(message)) {
          if (message.type === "key-ok") this.setPairReady(true);
          return;
        }
        return;
      case "accept":
      case "bitmap":
      case "progress":
      case "ack":
      case "pause":
      case "resume":
        if (this.sender?.onCtrl(message)) return;
        return;
      case "done":
        if (this.receiver?.onCtrl(message)) return;
        if (this.sender?.onCtrl(message)) return;
        return;
      case "error":
        if (this.sender?.onCtrl(message)) return;
        if (this.receiver?.onCtrl(message)) return;
        this.hooks.failed(message.msg || "peer error", message.code);
        return;
      default:
        return;
    }
  }

  private onManifest(manifest: Manifest): void {
    if (this.receiver) {
      if (this.receiver.transferId === manifest.transferId) return; // duplicate
      this.rejectBusy(manifest.transferId);
      return;
    }
    if (this.sender) {
      // Priority rule (ADR 0010): the admin's direction wins when both sides
      // start at the same time. A member yields while its own manifest has not
      // been accepted yet; otherwise the pair answers BUSY and the peer retries.
      const yieldToAdmin =
        !this.hooks.selfIsAdmin &&
        this.hooks.peerIsAdmin &&
        !this.sender.hasAccepted;
      if (!yieldToAdmin) {
        this.rejectBusy(manifest.transferId);
        return;
      }
      this.requeueOnCancel = true;
      this.sender.cancel();
    }
    this.startReceiver(manifest);
  }

  private rejectBusy(transferId: string): void {
    this.sendCtrl({
      v: 2,
      type: "error",
      transferId,
      code: "BUSY",
      msg: "pair has an active transfer",
    });
  }

  private startReceiver(manifest: Manifest): void {
    const receiver = new ReceiverTransfer({
      transferId: manifest.transferId,
      manifest,
      peerId: this.peerId,
      peerName: this.hooks.peerName(),
      caps: this.hooks.caps(),
      sessionKey: this.hooks.sessionKey(),
      getHandles: () => this.handles,
      whenOpen: () => this.whenOpen(),
      confirm: (view) => this.hooks.confirmIncoming(view),
      autoAccept: () => this.hooks.autoAccept(),
      isNativeShell: this.hooks.nativeShell(),
      callbacks: {
        incoming: (view) => this.hooks.incoming(view),
        accepted: () => this.hooks.incomingAccepted(),
        progress: (receivedBytes, totalBytes) =>
          this.hooks.incomingProgress(receivedBytes, totalBytes),
        fileDone: (result) => this.hooks.incomingFileDone(result),
        finished: (result) => this.hooks.incomingFinished(result),
        declined: (reason) => this.hooks.incomingDeclined(reason),
        failed: (message, code) => this.hooks.failed(message, code),
      },
    });
    this.receiver = receiver;
    void receiver
      .start()
      .catch((error: unknown) => {
        this.hooks.failed(errorMessage(error));
      })
      .finally(() => {
        if (this.receiver === receiver) this.receiver = undefined;
        this.notifyQueue();
        void this.pump();
      });
  }

  private onData(data: ArrayBuffer): void {
    this.dataChain = this.dataChain
      .then(async () => {
        const receiver = this.receiver;
        if (!receiver) return;
        const frame = decodeChunkFrame(coerceBytes(new Uint8Array(data)));
        await receiver.handleFrame(frame);
      })
      .catch((error: unknown) => {
        console.debug("[cf-pair] frame rejected", String(error));
        this.hooks.failed(errorMessage(error));
        this.receiver?.close();
      });
  }

  private whenOpen(): Promise<PeerHandles> {
    if (this.handles) return Promise.resolve(this.handles);
    return new Promise((resolve, reject) =>
      this.openWaiters.push({ resolve, reject }),
    );
  }

  private sendCtrl(message: CtrlMessage): void {
    const handles = this.handles;
    if (!handles || handles.ctrl.readyState !== "open") return;
    try {
      handles.ctrl.send(JSON.stringify(message));
    } catch {
      // The reopen path re-sends what still matters.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
