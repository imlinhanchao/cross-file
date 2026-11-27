/**
 * Outgoing transfer state machine (ADR 0010, docs/02 v2 §3.6/§6).
 *
 * One instance = one `transferId` between this device and one peer. The pair
 * serialises its transfers (peer.ts), so this class never has to negotiate with
 * a second concurrent transfer; it only deals with:
 *
 * - manifest → accept → chunks → done → ack,
 * - `error BUSY` (the pair was busy; the caller re-queues the job),
 * - a connection drop: wait for the rebuilt channel, let the receiver send its
 *   bitmap, then resend only the missing chunks (docs/02 §6.5).
 */
import {
  CHUNK_MIN,
  CHUNK_MAX,
  base64Decode,
  base64Encode,
  createFileSalt,
  decodeBitmap,
  deriveFileKey,
  effectiveChunkSize,
  importFileKey,
  sendFile,
  wholeFileSha256,
  type CtrlMessage,
  type FileManifestEntry,
  type Manifest,
  type PeerHandles,
} from "@crossfile/core";
import { errorText as copyErrorText } from "@crossfile/ui";
import type { FileView } from "../store.js";

export interface PreparedFile {
  file: File;
  entry: FileManifestEntry;
  /** whole-file digest computed once; reused across resumes */
  sha256: string;
}

export type SenderOutcome =
  | { ok: true; sha256?: string; bytes?: number }
  | { ok: false; busy: true }
  | { ok: false; error: string }
  /**
   * `by` says who ended it (docs/02 §10.2 cancel note):
   * - `local`: this device's user pressed 取消 (job is dropped, retry offered),
   * - `peer`: the receiver sent `cancel` (job dropped, retry offered),
   * - `yield`: this side yielded the pair to a higher-priority manifest (job
   *   stays queued and starts again when the pair is idle).
   */
  | { ok: false; cancelled: true; by: CancelSource };

export type CancelSource = "local" | "peer" | "yield";

export interface SenderCallbacks {
  /** manifest is about to be sent (UI shows the transfer card) */
  started(transferId: string, files: FileView[], totalBytes: number): void;
  progress(transferId: string, sentBytes: number, totalBytes: number): void;
  /** resume state changed (paused / resumed) */
  paused?(transferId: string, paused: boolean): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type AcceptOutcome =
  | { kind: "accepted"; ids: number[] }
  | { kind: "busy" }
  | { kind: "error"; message: string };

type AckOutcome = "lost" | { ok: boolean; error?: string };

const ACK_TIMEOUT_MS = 120_000;

export class SenderTransfer {
  readonly transferId: string;
  readonly files: File[];
  private readonly sessionKey: Uint8Array;
  private readonly getHandles: () => PeerHandles | undefined;
  private readonly callbacks: SenderCallbacks;
  private readonly prepared: PreparedFile[] = [];
  private chunkSize = CHUNK_MIN;
  private acceptedIds: number[] | null = null;
  private acceptDeferred: Deferred<AcceptOutcome> | null = null;
  private readonly ackWaiters = new Map<number, Deferred<AckOutcome>>();
  private readonly missing = new Map<number, number[]>();
  private readonly openWaiters: Array<() => void> = [];
  private lossDeferred: Deferred<void> | null = null;
  private lost = false;
  private aborted = false;
  /** who ended the transfer; null until {@link cancel} is called */
  private cancelSource: CancelSource | null = null;
  /** aborts the chunk loop immediately instead of waiting for the next yield */
  private readonly sendAbort = new AbortController();
  private flowPaused = false;
  private flowWaiters: Array<() => void> = [];
  private startedAt = 0;
  private totalBytes = 0;

  constructor(options: {
    transferId: string;
    files: File[];
    sessionKey: Uint8Array;
    getHandles: () => PeerHandles | undefined;
    callbacks: SenderCallbacks;
  }) {
    this.transferId = options.transferId;
    this.files = options.files;
    this.sessionKey = options.sessionKey;
    this.getHandles = options.getHandles;
    this.callbacks = options.callbacks;
  }

  /** True once the receiver accepted; before that it is safe to cancel/yield. */
  get hasAccepted(): boolean {
    return this.acceptedIds !== null;
  }

  /** Chunk size advertised in the manifest; stays fixed across resumes. */
  get manifestChunkSize(): number {
    return this.chunkSize;
  }

  /** Runs the whole transfer; resolves with the outcome (busy = caller re-queues). */
  async run(): Promise<SenderOutcome> {
    try {
      await this.prepare();
      this.startedAt = Date.now();
      this.callbacks.started(
        this.transferId,
        this.prepared.map((file) => ({
          id: file.entry.id,
          name: file.entry.name,
          size: file.entry.size,
          mime: file.entry.mime,
        })),
        this.totalBytes,
      );

      const accepted = await this.negotiateAccept();
      if (this.aborted) return this.cancelledOutcome();
      if (accepted.kind === "busy") return { ok: false, busy: true };
      if (accepted.kind === "error")
        return { ok: false, error: accepted.message };
      this.acceptedIds = accepted.ids;

      const files = this.prepared.filter((file) =>
        accepted.ids.includes(file.entry.id),
      );
      let completedBytes = 0;
      for (const file of files) {
        await this.sendOne(file, completedBytes);
        completedBytes += file.entry.size;
        this.callbacks.progress(
          this.transferId,
          completedBytes,
          this.totalBytes,
        );
      }
      const last = files[files.length - 1];
      return {
        ok: true,
        ...(last ? { sha256: last.sha256 } : {}),
        bytes: this.totalBytes,
      };
    } catch (error) {
      if (this.aborted) return this.cancelledOutcome();
      return { ok: false, error: errorText(error) };
    } finally {
      this.aborted = true;
      this.flushFlowWaiters();
      for (const waiter of this.ackWaiters.values())
        waiter.resolve({ ok: false, error: "transfer closed" });
      this.ackWaiters.clear();
    }
  }

  /**
   * Stop the transfer. `by` records who asked: the local user (`local`, the pair
   * then sends `cancel` to the peer), the peer's `cancel` message (`peer`), or a
   * priority yield (`yield`, the job stays queued).
   */
  cancel(by: CancelSource = "local"): void {
    if (this.aborted) return;
    this.cancelSource = by;
    this.aborted = true;
    this.sendAbort.abort();
    this.acceptDeferred?.resolve({ kind: "error", message: "cancelled" });
    // Wake a `done`→`ack` wait too, otherwise a cancel landing in that window
    // would sit until the 120 s ack timeout before the pair becomes idle.
    for (const waiter of this.ackWaiters.values())
      waiter.resolve({ ok: false, error: "cancelled" });
    this.ackWaiters.clear();
    this.flushFlowWaiters();
    for (const resolve of this.openWaiters.splice(0)) resolve();
  }

  private cancelledOutcome(): SenderOutcome {
    return { ok: false, cancelled: true, by: this.cancelSource ?? "local" };
  }

  /** Channel to the peer went away; wait for the rebuilt one. */
  onLost(): void {
    this.lost = true;
    this.flowPaused = false;
    this.flushFlowWaiters();
    // A pending accept belongs to the dead channel: the receiver will get the
    // manifest again once the connection is back (docs/02 §6.5).
    this.acceptDeferred = null;
    for (const waiter of this.ackWaiters.values()) waiter.resolve("lost");
    this.ackWaiters.clear();
    if (!this.lossDeferred) this.lossDeferred = deferred<void>();
  }

  /** Channel is back; the receiver sends its bitmap before we resend. */
  onReopen(): void {
    this.lost = false;
    for (const resolve of this.openWaiters.splice(0)) resolve();
    const lost = this.lossDeferred;
    this.lossDeferred = null;
    lost?.resolve();
  }

  /** Resume support: receiver tells us which chunks it already has. */
  onCtrl(message: CtrlMessage): boolean {
    if ("transferId" in message && message.transferId !== this.transferId)
      return false;
    switch (message.type) {
      case "accept":
        this.acceptDeferred?.resolve({
          kind: "accepted",
          ids: message.fileIds,
        });
        return true;
      case "bitmap":
        this.onBitmap(message);
        return true;
      case "ack": {
        this.ackWaiters.get(message.fileId)?.resolve({
          ok: message.ok,
          ...(message.error !== undefined ? { error: message.error } : {}),
        });
        return true;
      }
      case "error": {
        if (message.code === "BUSY") {
          this.acceptDeferred?.resolve({ kind: "busy" });
          return true;
        }
        const failure = {
          ok: false,
          error: copyErrorText(message.code, message.msg),
        };
        if (message.fileId !== undefined)
          this.ackWaiters.get(message.fileId)?.resolve(failure);
        this.acceptDeferred?.resolve({
          kind: "error",
          message: copyErrorText(message.code, message.msg),
        });
        return true;
      }
      case "pause":
        this.flowPaused = true;
        this.callbacks.paused?.(this.transferId, true);
        return true;
      case "resume":
        this.flowPaused = false;
        this.callbacks.paused?.(this.transferId, false);
        this.flushFlowWaiters();
        return true;
      default:
        return false;
    }
  }

  /** Called by the pair when a bitmap arrives (kept separate from onCtrl for typing). */
  onBitmap(message: Extract<CtrlMessage, { type: "bitmap" }>): void {
    if (message.transferId !== this.transferId) return;
    const entry = this.prepared.find(
      (file) => file.entry.id === message.fileId,
    );
    if (!entry) return;
    const received = decodeBitmap(message.bits, entry.entry.chunkCount);
    const missing: number[] = [];
    for (let seq = 0; seq < entry.entry.chunkCount; seq++)
      if (!received.has(seq)) missing.push(seq);
    this.missing.set(message.fileId, missing);
  }

  private async prepare(): Promise<void> {
    const handles = await this.whenOpenOrNow();
    const maxMessageSize =
      (handles.pc.sctp as { maxMessageSize?: number } | null)?.maxMessageSize ??
      CHUNK_MAX + 28;
    this.chunkSize = effectiveChunkSize(CHUNK_MIN, maxMessageSize);
    let id = 0;
    for (const file of this.files) {
      id += 1;
      const salt = createFileSalt();
      const chunkCount = Math.max(1, Math.ceil(file.size / this.chunkSize));
      this.prepared.push({
        file,
        sha256: await wholeFileSha256(file, this.chunkSize),
        entry: {
          id,
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          chunk: this.chunkSize,
          chunkCount,
          salt: base64Encode(salt),
        },
      });
    }
    this.totalBytes = this.prepared.reduce(
      (sum, file) => sum + file.entry.size,
      0,
    );
  }

  private async negotiateAccept(): Promise<AcceptOutcome> {
    const manifest: Manifest = {
      v: 2,
      type: "manifest",
      transferId: this.transferId,
      files: this.prepared.map((file) => file.entry),
      totalSize: this.totalBytes,
      chunkNegotiation: { min: CHUNK_MIN, max: CHUNK_MAX },
    };
    while (!this.aborted) {
      const handles = this.getHandles();
      if (!handles) {
        await this.waitOpen();
        continue;
      }
      this.acceptDeferred = deferred<AcceptOutcome>();
      try {
        handles.ctrl.send(JSON.stringify(manifest));
      } catch {
        // The channel died between the readiness check and the send.
        await this.waitOpen();
        continue;
      }
      const lost = this.lostSignal();
      const outcome = await Promise.race([this.acceptDeferred.promise, lost]);
      if (outcome === "lost") {
        await this.waitOpen();
        continue;
      }
      return outcome;
    }
    return { kind: "error", message: "cancelled" };
  }

  private async sendOne(
    file: PreparedFile,
    completedBytes: number,
  ): Promise<void> {
    const key = await importFileKey(
      deriveFileKey(this.sessionKey, this.transferId, file.entry.id),
    );
    const salt = base64Decode(file.entry.salt);
    while (!this.aborted) {
      const handles = this.getHandles();
      if (!handles) {
        await this.waitOpen();
        continue;
      }
      const missing = this.missing.get(file.entry.id);
      try {
        await sendFile({
          fileId: file.entry.id,
          file: file.file,
          chunkSize: this.chunkSize,
          salt,
          key,
          channel: handles.data,
          signal: this.sendAbort.signal,
          computeHash: false,
          onlyChunks: missing,
          maxMessageSize: CHUNK_MAX + 28,
          waitIfPaused: () => this.waitIfPaused(),
          onProgress: (sentBytes) => {
            this.callbacks.progress(
              this.transferId,
              completedBytes + sentBytes,
              this.totalBytes,
            );
          },
        });
      } catch (error) {
        if (this.aborted) throw error;
        // Channel dropped mid-file: the receiver will send a bitmap after the
        // rebuild, so the next loop only resends the chunks it lacks.
        await this.waitOpen();
        continue;
      }
      const ack = await this.sendDone(file, handles);
      if (ack === "lost") {
        await this.waitOpen();
        continue;
      }
      if (!ack.ok)
        throw new Error(ack.error ?? "receiver failed to verify the file");
      this.missing.delete(file.entry.id);
      return;
    }
    throw new Error("transfer aborted");
  }

  private async sendDone(
    file: PreparedFile,
    handles: PeerHandles,
  ): Promise<AckOutcome> {
    const waiter = deferred<AckOutcome>();
    this.ackWaiters.set(file.entry.id, waiter);
    try {
      handles.ctrl.send(
        JSON.stringify({
          v: 2,
          type: "done",
          transferId: this.transferId,
          fileId: file.entry.id,
          sha256: file.sha256,
          chunkCount: file.entry.chunkCount,
        }),
      );
    } catch {
      this.ackWaiters.delete(file.entry.id);
      return "lost";
    }
    const timeout = new Promise<AckOutcome>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, error: "ack timeout" }),
        ACK_TIMEOUT_MS,
      ),
    );
    return Promise.race([waiter.promise, this.lostSignal(), timeout]);
  }

  private lostSignal(): Promise<"lost"> {
    if (!this.lossDeferred) this.lossDeferred = deferred<void>();
    const current = this.lossDeferred;
    return current.promise.then(() => "lost" as const);
  }

  private async waitOpen(): Promise<void> {
    if (!this.lost && this.getHandles()) return;
    await new Promise<void>((resolve) => this.openWaiters.push(resolve));
  }

  private async whenOpenOrNow(): Promise<PeerHandles> {
    while (!this.aborted) {
      const handles = this.getHandles();
      if (handles) return handles;
      await this.waitOpen();
    }
    throw new Error("transfer cancelled");
  }

  private async waitIfPaused(): Promise<void> {
    while (this.flowPaused && !this.aborted) {
      await new Promise<void>((resolve) => this.flowWaiters.push(resolve));
    }
  }

  private flushFlowWaiters(): void {
    for (const resolve of this.flowWaiters.splice(0)) resolve();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
