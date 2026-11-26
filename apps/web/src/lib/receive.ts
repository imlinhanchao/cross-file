/**
 * Incoming transfer state machine (ADR 0010, docs/02 v2 §3.6/§6).
 *
 * One instance = one `transferId` sent by one peer. It asks this device for
 * consent (D19: the receiver's `accept` is the authorisation), streams decrypted
 * chunks into a save sink, verifies the whole-file SHA-256 and acks. A rebuilt
 * channel makes it re-announce what it already has via `bitmap` (docs/02 §6.5).
 */
import {
  ChunkReceiver,
  base64Decode,
  deriveFileKey,
  importFileKey,
  judgeFile,
  type ChunkFrame,
  type CtrlMessage,
  type Manifest,
  type PeerHandles,
} from "@crossfile/core";
import { createNativeSink, type SaveSink } from "./native.js";
import type { Caps } from "@crossfile/core";
import { copy } from "@crossfile/ui";
import type { FileView, IncomingView, ResultView, RiskView } from "../store.js";

export interface ReceiverCallbacks {
  /** manifest arrived and consent is needed (or auto-accepted) */
  incoming(view: IncomingView): void;
  /** consent was granted; chunks are coming */
  accepted(): void;
  progress(receivedBytes: number, totalBytes: number): void;
  /** one file finished and was saved */
  fileDone(result: ResultView): void;
  /** the whole transfer finished */
  finished(result: ResultView): void;
  /** the receiver declined / refused the manifest */
  declined(reason: string): void;
  failed(message: string, code?: string): void;
}

interface FileReceiver {
  entry: Manifest["files"][number];
  receiver: ChunkReceiver;
  sink: SaveSink | null;
}

export interface ReceiverOptions {
  transferId: string;
  manifest: Manifest;
  peerId: string;
  peerName: string;
  /** this device's capabilities (limit + save strategy decisions) */
  caps: Caps;
  sessionKey: Uint8Array;
  getHandles: () => PeerHandles | undefined;
  /** wait until the rebuilt channel is usable again */
  whenOpen: () => Promise<PeerHandles>;
  confirm: (view: IncomingView) => Promise<boolean>;
  /** DEV-ONLY diagnostics hook: accept without a tap (shells + e2e) */
  autoAccept: () => boolean;
  isNativeShell: boolean;
  callbacks: ReceiverCallbacks;
}

export class ReceiverTransfer {
  readonly transferId: string;
  private readonly opts: ReceiverOptions;
  private readonly files = new Map<number, FileReceiver>();
  private readonly fileBytes = new Map<number, number>();
  private acceptedIds: number[] = [];
  private accepted = false;
  private doneIds = new Set<number>();
  private totalBytes = 0;
  private receivedBytes = 0;
  private pendingFrameBytes = 0;
  private receiverPaused = false;
  private result?: ResultView;
  private closed = false;
  private finishSignal: {
    promise: Promise<void>;
    resolve(): void;
  } = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  })();

  constructor(options: ReceiverOptions) {
    this.transferId = options.transferId;
    this.opts = options;
  }

  /** Run the consent + receive flow; resolves when the transfer ends. */
  async start(): Promise<void> {
    this.totalBytes = this.opts.manifest.files.reduce(
      (sum, file) => sum + file.size,
      0,
    );
    const verdict = judgeFile(this.totalBytes, this.opts.caps);
    const risk: RiskView | undefined =
      verdict.level === "reject"
        ? {
            level: "reject",
            message: rejectMessage(this.totalBytes, verdict.hardLimitMB),
            softLimitMB: verdict.softLimitMB,
            hardLimitMB: verdict.hardLimitMB,
            totalBytes: this.totalBytes,
          }
        : verdict.level === "warn"
          ? {
              level: "warn",
              message: warnMessage(
                this.totalBytes,
                verdict.softLimitMB,
                this.opts.caps,
              ),
              softLimitMB: verdict.softLimitMB,
              hardLimitMB: verdict.hardLimitMB,
              totalBytes: this.totalBytes,
            }
          : undefined;

    if (verdict.level === "reject" && risk) {
      // docs/01 §6: above the hard limit the receiver refuses outright.
      this.send({
        v: 2,
        type: "error",
        transferId: this.transferId,
        code: "TOO_LARGE",
        msg: `receiver hard limit ${verdict.hardLimitMB} MB`,
      });
      this.opts.callbacks.failed(risk.message, "TOO_LARGE");
      this.finishSignal.resolve();
      return;
    }

    const view: IncomingView = {
      transferId: this.transferId,
      peerId: this.opts.peerId,
      peerName: this.opts.peerName,
      files: this.opts.manifest.files.map(fileView),
      totalBytes: this.totalBytes,
      ...(risk ? { risk } : {}),
    };
    this.opts.callbacks.incoming(view);

    const granted = this.opts.autoAccept() || (await this.opts.confirm(view));
    if (!granted || this.closed) {
      this.send({
        v: 2,
        type: "error",
        transferId: this.transferId,
        code: "CAPABILITY_RISK_DECLINED",
        msg: "receiver declined the transfer",
      });
      this.opts.callbacks.declined("receiver declined");
      this.finishSignal.resolve();
      return;
    }

    this.accepted = true;
    this.acceptedIds = this.opts.manifest.files.map((file) => file.id);
    const handles = await this.opts.whenOpen();
    handles.ctrl.send(
      JSON.stringify({
        v: 2,
        type: "accept",
        transferId: this.transferId,
        fileIds: this.acceptedIds,
      }),
    );
    this.opts.callbacks.accepted();
    await this.finishSignal.promise;
  }

  /** Data-channel frame for this transfer. */
  async handleFrame(frame: ChunkFrame): Promise<void> {
    if (this.closed) return;
    const entry = this.opts.manifest.files.find(
      (file) => file.id === frame.fileId,
    );
    if (!entry) return;
    this.pendingFrameBytes += frame.ciphertext.length;
    try {
      const file = await this.ensureFile(entry);
      await file.receiver.handleFrame(frame);
      this.opts.callbacks.progress(this.receivedBytes, this.totalBytes);
    } finally {
      this.pendingFrameBytes -= frame.ciphertext.length;
      this.updateFlow();
    }
  }

  onCtrl(message: CtrlMessage): boolean {
    if (!("transferId" in message) || message.transferId !== this.transferId)
      return false;
    switch (message.type) {
      case "done":
        void this.finishFile(message);
        return true;
      case "error": {
        this.opts.callbacks.failed(
          message.msg || copy.verifyFailed,
          message.code,
        );
        this.close();
        return true;
      }
      default:
        return false;
    }
  }

  /** The pair's channel was rebuilt: re-announce what is already on disk. */
  onReopen(): void {
    if (this.closed || !this.accepted) return;
    for (const [fileId, file] of this.files) {
      if (file.receiver.isComplete()) continue;
      this.send({
        v: 2,
        type: "bitmap",
        transferId: this.transferId,
        fileId,
        bits: file.receiver.bitmap(),
      });
    }
  }

  onLost(): void {
    this.pendingFrameBytes = 0;
    this.receiverPaused = false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const file of this.files.values()) {
      if (file.sink) void file.sink.abort().catch(() => undefined);
    }
    this.finishSignal.resolve();
  }

  /** Pending decrypted bytes (docs/02 §6.4 backpressure), read by the pair. */
  get pendingBytes(): number {
    return this.pendingFrameBytes;
  }

  private async ensureFile(
    entry: Manifest["files"][number],
  ): Promise<FileReceiver> {
    const existing = this.files.get(entry.id);
    if (existing) return existing;
    const salt = base64Decode(entry.salt);
    const key = await importFileKey(
      deriveFileKey(this.opts.sessionKey, this.transferId, entry.id),
    );
    let sink: SaveSink | null = null;
    if (this.opts.isNativeShell) {
      sink = createNativeSink();
      await sink.open(entry.name);
    }
    const sinkRef = sink;
    const receiver = new ChunkReceiver({
      fileId: entry.id,
      size: entry.size,
      chunkSize: entry.chunk,
      chunkCount: entry.chunkCount,
      salt,
      key,
      progressEveryChunks: 10,
      onProgress: (receivedBytes: number) => {
        this.fileBytes.set(entry.id, receivedBytes);
        this.receivedBytes = [...this.fileBytes.values()].reduce(
          (sum, value) => sum + value,
          0,
        );
        this.opts.callbacks.progress(this.receivedBytes, this.totalBytes);
      },
      ...(sinkRef
        ? {
            onChunk: (offset: number, plaintext: Uint8Array) =>
              sinkRef.write(offset, plaintext),
          }
        : {}),
    });
    const file: FileReceiver = { entry, receiver, sink };
    this.files.set(entry.id, file);
    return file;
  }

  private async finishFile(
    message: Extract<CtrlMessage, { type: "done" }>,
  ): Promise<void> {
    const file = this.files.get(message.fileId);
    if (!file || this.closed) return;
    if (this.doneIds.has(message.fileId)) {
      // A resume may make the sender re-send `done` for a file we already acked.
      this.send({
        v: 2,
        type: "ack",
        transferId: this.transferId,
        fileId: message.fileId,
        ok: true,
      });
      return;
    }
    // `done` travels on ctrl and may overtake the tail of the data channel.
    const deadline = Date.now() + 60_000;
    while (!file.receiver.isComplete() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const result = file.receiver.finish();
    const ok = result.complete && result.sha256 === message.sha256;
    this.send({
      v: 2,
      type: "ack",
      transferId: this.transferId,
      fileId: message.fileId,
      ok,
    });
    if (!ok) {
      if (file.sink) {
        await file.sink.abort().catch(() => undefined);
        file.sink = null;
      }
      this.opts.callbacks.failed(
        `${copy.verifyFailed} (${result.complete ? "hash" : "incomplete"} ${result.sha256.slice(0, 12)} ≠ ${message.sha256.slice(0, 12)})`,
        "HASH_MISMATCH",
      );
      this.close();
      return;
    }

    let view: ResultView;
    if (file.sink) {
      // Native shell: bytes went straight to disk by offset.
      const savedPath = await file.sink.close();
      file.sink = null;
      view = {
        ok: true,
        sha256: result.sha256,
        path: savedPath,
        fileName: file.entry.name,
        bytes: result.size,
      };
    } else {
      const bytes = file.receiver.collectBytes();
      const blob = new Blob([bytes.buffer as ArrayBuffer], {
        type: file.entry.mime,
      });
      view = {
        ok: true,
        sha256: result.sha256,
        url: URL.createObjectURL(blob),
        fileName: file.entry.name,
        bytes: bytes.length,
      };
    }
    this.doneIds.add(message.fileId);
    this.result = view;
    this.opts.callbacks.fileDone(view);
    if (this.acceptedIds.every((id) => this.doneIds.has(id))) {
      this.opts.callbacks.finished(view);
      this.finishSignal.resolve();
    }
  }

  private updateFlow(): void {
    const handles = this.opts.getHandles();
    if (!handles || handles.ctrl.readyState !== "open") return;
    const HIGH = 24 * 1024 * 1024;
    const LOW = 4 * 1024 * 1024;
    if (!this.receiverPaused && this.pendingFrameBytes > HIGH) {
      this.receiverPaused = true;
      this.send({
        v: 2,
        type: "pause",
        transferId: this.transferId,
      });
    } else if (this.receiverPaused && this.pendingFrameBytes < LOW) {
      this.receiverPaused = false;
      this.send({
        v: 2,
        type: "resume",
        transferId: this.transferId,
      });
    }
  }

  private send(message: CtrlMessage): void {
    const handles = this.opts.getHandles();
    if (!handles || handles.ctrl.readyState !== "open") return;
    try {
      handles.ctrl.send(JSON.stringify(message));
    } catch {
      // The channel died; the reopen path re-sends what still matters.
    }
  }
}

function fileView(entry: Manifest["files"][number]): FileView {
  return { id: entry.id, name: entry.name, size: entry.size, mime: entry.mime };
}

function warnMessage(
  totalBytes: number,
  softLimitMB: number,
  caps: Caps,
): string {
  const mb = Math.round(totalBytes / (1024 * 1024));
  if (caps.platform === "ios") {
    return `这台 iPhone 接收 ${mb} MB 风险较高。浏览器最多稳定保存约 ${softLimitMB} MB。建议改用电脑接收，或安装 CrossFile App。`;
  }
  return `这台设备接收 ${mb} MB 可能无法保存（稳定上限约 ${softLimitMB} MB）。可以继续，但建议改用电脑接收或安装 App。`;
}

function rejectMessage(totalBytes: number, hardLimitMB: number): string {
  const mb = Math.round(totalBytes / (1024 * 1024));
  return `对方要发 ${mb} MB，超过这台设备能接收的上限（约 ${hardLimitMB} MB）。可以让对方改用电脑接收，或安装 CrossFile App。`;
}
