import type { ClientMessage, ServerMessage, SignalPayload } from "@crossfile/core";

export function signalingUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/v1/ws`;
}

type MessageHandler = (message: ServerMessage) => void;

/** Thin typed WebSocket client: queues messages until open, validates on the server. */
export class SignalingSocket {
  private ws: WebSocket | null = null;
  private readonly outbox: ClientMessage[] = [];
  private readonly handlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<(event: CloseEvent) => void>();

  async connect(url = signalingUrl()): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        for (const message of this.outbox.splice(0)) ws.send(JSON.stringify(message));
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("signaling connection failed")), { once: true });
      ws.addEventListener("message", (event) => {
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        for (const handler of this.handlers) handler(parsed);
      });
      ws.addEventListener("close", (event) => {
        for (const handler of this.closeHandlers) handler(event);
      });
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: (event: CloseEvent) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    else this.outbox.push(message);
  }

  signal(to: string, payload: SignalPayload): void {
    this.send({ v: 1, type: "signal", to, payload });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

/** Small deferred helper for request/response style control messages. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
