/**
 * One `PeerConnection` per pair of members (ADR 0010, docs/02 v2).
 *
 * Responsibilities:
 * - own the WebRTC peer (the pair's elected offerer creates the offer),
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
import { ReceiverTransfer, type ReceiverCancelSource } from "./receive.js";
import { CtrlHeartbeat } from "./heartbeat.js";
import { ctrlHeartbeatMs, ctrlTimeoutMs } from "./timeout.js";
import type { FileView, IncomingView, ResultView } from "../store.js";

export interface PeerSessionHooks {
  /** current role, read at use time: an admin hand-over may flip it mid-session */
  selfIsAdmin(): boolean;
  peerIsAdmin(): boolean;
  /**
   * This side is the pair's offerer (docs/02 §11.1: smaller memberId, except
   * the admin on the 6-digit SAS path). Read dynamically so a role change or a
   * member-list update is honoured on the next attach.
   */
  offerer(): boolean;
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
  /** the active incoming transfer was cancelled (by this user or by the sender) */
  incomingCancelled(by: ReceiverCancelSource): void;
  outgoingStarted(
    transferId: string,
    files: FileView[],
    totalBytes: number,
  ): void;
  outgoingProgress(sentBytes: number, totalBytes: number): void;
  outgoingPaused(paused: boolean): void;
  /** `files` are kept by the controller so a failed/cancelled job can be retried */
  outgoingFinished(outcome: SenderOutcome, files: File[]): void;
  /** queue for this pair changed (for the UI); the active job is not listed */
  queueChanged(jobs: QueuedJobView[], busy: boolean): void;
  failed(message: string, code?: string): void;
  confirmIncoming(view: IncomingView): Promise<boolean>;
  /** `${selfId}:${counter}` — monotonic, unique per sender per session */
  nextTransferId(): string;
}

const REBUILD_RETRY_MS = 800;

/** One queued (not yet running) outgoing job for this pair. */
interface OutJob {
  /** monotonic per pair; lets the UI cancel exactly this job */
  id: number;
  files: File[];
}

export interface QueuedJobView {
  jobId: number;
  files: FileView[];
}

export class PeerSession {
  readonly peerId: string;
  private readonly hooks: PeerSessionHooks;
  private peer?: Peer;
  private handles?: PeerHandles;
  /** role this PC was created with; undefined while no PC is being negotiated */
  private attachedAsOfferer?: boolean;
  private sender?: SenderTransfer;
  private receiver?: ReceiverTransfer;
  private readonly outQueue: OutJob[] = [];
  private jobCounter = 0;
  /** data frames are ordered on the wire; process them strictly in order too */
  private dataChain: Promise<void> = Promise.resolve();
  private openWaiters: Array<{
    resolve(handles: PeerHandles): void;
    reject(error: Error): void;
  }> = [];
  private pumping = false;
  private closed = false;
  private pairReady = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: CtrlHeartbeat;

  constructor(peerId: string, hooks: PeerSessionHooks) {
    this.peerId = peerId;
    this.hooks = hooks;
  }

  get busy(): boolean {
    return (
      this.sender !== undefined ||
      (this.receiver !== undefined && !this.receiver.isClosed)
    );
  }

  get hasHandles(): boolean {
    return this.handles !== undefined;
  }

  /** A PC is being negotiated (offer sent or answer expected) but not open yet. */
  get connecting(): boolean {
    return this.peer !== undefined;
  }

  get queuedCount(): number {
    return this.outQueue.length;
  }

  /** Create a fresh peer connection (also used after a channel drop). */
  attach(): void {
    this.attachAs(this.hooks.offerer());
  }

  /**
   * Create a PC in an explicit role. Normally the role comes from the election;
   * the exception is an elected offerer that receives an offer before it ever
   * attached: answering is then the only way to form the pair (the sending side
   * becomes the connection's offerer for this attempt).
   */
  private attachAs(offerer: boolean): void {
    if (this.closed) return;
    this.disposePeer();
    this.attachedAsOfferer = offerer;
    const options = {
      iceServers: iceServersFromTurn(this.hooks.turn),
      relayOnly: this.hooks.relayOnly,
      sendSignal: (payload: SignalPayload) => this.hooks.sendSignal(payload),
      onError: (error: unknown) => {
        console.debug("[cf-pair] peer error", String(error));
        this.handleLost();
      },
    };
    const peer = offerer
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
    if (payload.k === "offer") {
      // The pair's offerer rebuilds after a drop; the answerer always starts a
      // fresh answerer. The old connection may still look alive because its close
      // event is delivered late (Chrome timing differs across machines); reusing it
      // would apply the new offer to a dead channel and leave the sender stuck.
      // If we created the offer ourselves, ours wins and the duplicate is ignored
      // (glare). If we have no PC yet — an elected offerer whose peer offered
      // first — answering is the only way to form the cold pair.
      if (this.peer && this.attachedAsOfferer === true) return;
      if (this.peer) this.handleLost();
      this.attachAs(false);
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
    this.jobCounter += 1;
    this.outQueue.push({ id: this.jobCounter, files });
    this.notifyQueue();
    void this.pump();
  }

  /**
   * Cancel the pair's active transfer (either direction), docs/02 §10.2 cancel.
   * The local side ends immediately; the peer is told with a ctrl `cancel` and
   * the pair becomes idle so the next queued job can start without waiting for
   * an acknowledgement.
   */
  cancelActive(): boolean {
    const sender = this.sender;
    if (sender) {
      const transferId = sender.transferId;
      sender.cancel("local");
      this.sendCtrl({ v: 2, type: "cancel", transferId, reason: "user" });
      return true;
    }
    const receiver = this.receiver;
    if (receiver) {
      receiver.cancel("local");
      return true;
    }
    return false;
  }

  /** Remove one waiting job (no peer notification is needed for a queued job). */
  cancelQueued(jobId: number): boolean {
    // outQueue[0] is the running job while `sender` is set; never cancel that
    // one through this path — cancelActive() owns it.
    const first = this.sender ? 1 : 0;
    for (let index = first; index < this.outQueue.length; index += 1) {
      if (this.outQueue[index]!.id !== jobId) continue;
      this.outQueue.splice(index, 1);
      this.notifyQueue();
      return true;
    }
    return false;
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
    this.stopHeartbeat();
    this.sender?.cancel("local");
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
    if (this.hooks.hasKey()) {
      // Idempotent "this side holds the roomKey" signal (docs/02 §10.2). Both
      // sides send it on every pair open, so any member↔member pair becomes
      // ready without a second SAS ceremony; on the 6-digit path the keyless
      // side sends it once the admin's room-key has arrived.
      this.sendCtrl({ v: 2, type: "key-ok" });
    }
    this.setPairReady(
      this.hooks.offerer() ? this.pairReady : this.hooks.hasKey(),
    );
    // The pair is open: start the per-pair ctrl heartbeat (docs/02 §10.2). It is
    // stopped again by handleLost()/close(); a peer that sends nothing at all is
    // declared lost after CtrlHeartbeat's timeout and the pair is rebuilt.
    this.startHeartbeat();
    this.onReopen();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const heartbeat = new CtrlHeartbeat({
      heartbeatMs: ctrlHeartbeatMs(),
      timeoutMs: ctrlTimeoutMs(),
      sendPing: () => this.sendCtrl({ v: 2, type: "ping" }),
      onTimeout: () => {
        console.debug("[cf-pair] ctrl heartbeat timeout", this.peerId);
        this.handleLost();
      },
    });
    this.heartbeat = heartbeat;
    heartbeat.start();
  }

  private stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = undefined;
  }

  private handleLost(): void {
    this.stopHeartbeat();
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
    this.attachedAsOfferer = undefined;
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
      const job = this.outQueue[0]!;
      const files = job.files;
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
      // The session may have been closed while the transfer was unwinding; the
      // store is already torn down then, so do not report a stale outcome.
      if (this.closed) return;
      if (outcome.ok) {
        this.outQueue.shift();
        this.hooks.outgoingFinished(outcome, files);
      } else if ("busy" in outcome && outcome.busy) {
        // The pair is busy on the other direction: retry when it frees up.
        this.hooks.outgoingFinished(outcome, files);
        this.scheduleRetry();
        this.notifyQueue();
        return;
      } else if ("cancelled" in outcome && outcome.cancelled) {
        if (outcome.by === "yield") {
          // We yielded the pair; our job waits at the head and starts again once
          // the peer's higher-priority transfer is done.
          this.hooks.outgoingFinished(outcome, files);
        } else {
          // local/user cancel or the peer's cancel: the job is over (the
          // controller keeps the files for a retry with a fresh transferId).
          this.outQueue.shift();
          this.hooks.outgoingFinished(outcome, files);
        }
      } else {
        this.outQueue.shift();
        this.hooks.outgoingFinished(outcome, files);
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
    // outQueue[0] is the job currently running; the UI shows it as a transfer
    // card, not as a queued item, so only the jobs behind it are listed.
    const waiting = this.sender ? this.outQueue.slice(1) : this.outQueue;
    this.hooks.queueChanged(
      waiting.map((job) => ({
        jobId: job.id,
        files: job.files.map((file, index) => ({
          id: index + 1,
          name: file.name,
          size: file.size,
          mime: file.type,
        })),
      })),
      this.busy,
    );
  }

  private onCtrl(raw: unknown): void {
    if (this.closed) return;
    // Any frame proves the pair is alive, including one that fails to parse below.
    this.heartbeat?.noteActivity();
    let message: CtrlMessage;
    try {
      message = parseCtrlMessage(
        typeof raw === "string" ? JSON.parse(raw) : raw,
      );
    } catch {
      return;
    }
    switch (message.type) {
      case "ping":
        this.sendCtrl({ v: 2, type: "pong" });
        return;
      case "pong":
        return;
      case "cancel":
        this.onCancel(message);
        return;
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

  /**
   * ctrl `cancel` (docs/02 §10.2): stop whichever transfer the id belongs to and
   * go back to idle. A stale/unknown id is ignored — the same pair runs one
   * transfer at a time, so a mismatch can only be a late frame from a finished
   * one. We do not answer: the cancelling side already ended locally, and not
   * waiting for an ack keeps this a one-way notice.
   */
  private onCancel(message: Extract<CtrlMessage, { type: "cancel" }>): void {
    if (this.sender?.transferId === message.transferId) {
      this.sender.cancel("peer");
      return;
    }
    if (this.receiver?.transferId === message.transferId) {
      this.receiver.cancel("peer");
    }
  }

  private onManifest(manifest: Manifest): void {
    if (this.receiver && !this.receiver.isClosed) {
      if (this.receiver.transferId === manifest.transferId) return; // duplicate
      this.rejectBusy(manifest.transferId);
      return;
    }
    if (this.sender) {
      // Priority rule (ADR 0010): the admin's direction wins when both sides
      // start at the same time. A member yields while its own manifest has not
      // been accepted yet; otherwise the pair answers BUSY and the peer retries.
      // docs/02 §6.5: the pair's offerer wins a simultaneous start (on the
      // 6-digit path the admin is the offerer), so the other side yields its
      // unaccepted send.
      const yieldToPriority = !this.hooks.offerer() && !this.sender.hasAccepted;
      if (!yieldToPriority) {
        this.rejectBusy(manifest.transferId);
        return;
      }
      this.sender.cancel("yield");
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
        cancelled: (by) => this.hooks.incomingCancelled(by),
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
    this.heartbeat?.noteActivity();
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
