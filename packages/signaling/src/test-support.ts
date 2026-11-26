/**
 * Test-only helpers: a tiny real `ws` client and protocol fixtures. Not part of the package
 * surface (nothing in index.ts exports it) and not used by the server at runtime.
 */
import { WebSocket } from "ws";
import type { Caps, ServerMessage } from "@crossfile/core/protocol";

/** Room creator (desktop Chrome): v2 calls it the admin. */
export const ADMIN_CAPS: Caps = {
  platform: "linux",
  uaFamily: "chrome",
  nativeShell: false,
  secureContext: true,
  fsAccess: true,
  sw: true,
  swDownload: false,
  saveStrategies: ["fs", "blob"],
  deviceMemoryGB: 16,
  storageQuotaMB: 51_200,
  screen: "desktop",
};

/** Joiner (iPhone Safari): v2 calls it a member, and it may send back too. */
export const MEMBER_CAPS: Caps = {
  platform: "ios",
  uaFamily: "safari",
  nativeShell: false,
  secureContext: true,
  fsAccess: false,
  sw: true,
  swDownload: true,
  saveStrategies: ["sw", "blob"],
  deviceMemoryGB: 6,
  storageQuotaMB: 10_240,
  screen: "phone",
};

/** @deprecated v1 fixture names; tests are migrating to ADMIN_CAPS / MEMBER_CAPS. */
export const HOST_CAPS = ADMIN_CAPS;
/** @deprecated v1 fixture names; tests are migrating to ADMIN_CAPS / MEMBER_CAPS. */
export const GUEST_CAPS = MEMBER_CAPS;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type MessageType = ServerMessage["type"];

/** The concrete server message for one type tag. */
export type MessageOf<T extends MessageType> = Extract<
  ServerMessage,
  { type: T }
>;

interface Waiter {
  types: MessageType[];
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TestClient {
  private readonly socket: WebSocket;
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private closeInfo: { code: number; reason: string } | null = null;
  private readonly closeResolvers: Array<
    (info: { code: number; reason: string }) => void
  > = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data: unknown, isBinary: boolean) => {
      if (isBinary) return;
      try {
        this.dispatch(JSON.parse(String(data)) as ServerMessage);
      } catch {
        // the server only sends JSON text; ignore anything else
      }
    });
    socket.on("close", (code: number, reason: Buffer) => {
      this.closeInfo = { code, reason: reason.toString() };
      for (const resolve of this.closeResolvers.splice(0))
        resolve(this.closeInfo);
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(
            `socket closed while waiting for ${waiter.types.join("|")}`,
          ),
        );
      }
    });
    socket.on("error", () => {
      // close event carries the failure; individual tests assert on codes/messages
    });
  }

  static async open(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error: Error) => reject(error));
      socket.once("unexpected-response", (_request, response) => {
        reject(
          new Error(`websocket upgrade failed with ${response.statusCode}`),
        );
      });
    });
    return new TestClient(socket);
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendText(text: string): void {
    this.socket.send(text);
  }

  next<T extends MessageType>(
    type: T,
    timeoutMs = 2_000,
  ): Promise<MessageOf<T>> {
    return this.nextAny([type], timeoutMs) as Promise<MessageOf<T>>;
  }

  nextAny(types: MessageType[], timeoutMs = 2_000): Promise<ServerMessage> {
    const index = this.queue.findIndex((message) =>
      types.includes(message.type),
    );
    if (index >= 0) {
      const [message] = this.queue.splice(index, 1);
      return Promise.resolve(message!);
    }
    if (this.closeInfo) {
      return Promise.reject(
        new Error(`socket already closed while waiting for ${types.join("|")}`),
      );
    }
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`timed out waiting for ${types.join("|")}`));
      }, timeoutMs);
      this.waiters.push({ types, resolve, reject, timer });
    });
  }

  closed(timeoutMs = 2_000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for close")),
        timeoutMs,
      );
      this.closeResolvers.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = this.closed().catch(() => null);
    this.socket.close();
    await closed;
  }

  private dispatch(message: ServerMessage): void {
    const at = this.waiters.findIndex((waiter) =>
      waiter.types.includes(message.type),
    );
    if (at >= 0) {
      const [waiter] = this.waiters.splice(at, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
      return;
    }
    this.queue.push(message);
  }
}
