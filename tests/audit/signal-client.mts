/**
 * Real signaling session for the zero-storage audit (docs/01 AC8, docs/02 §7).
 *
 * Unlike `scripts/smoke-signaling.mts` (which starts an in-process server on port 0), this
 * client only speaks to a *separate* server over `ws://127.0.0.1:<port>/v1/ws`, so the audit
 * script can strace the server process while a complete create → join → approve → signal →
 * close session runs through it.
 *
 * Run: node --import tsx tests/audit/signal-client.mts [ws-url]
 * Env: AUDIT_WS_URL (default ws://127.0.0.1:18787/v1/ws)
 *
 * Exit code 0 = all steps passed, 1 = failure (printed as `CLIENT FAIL ...`).
 */
import WebSocket from "ws";
import { base32Encode, randomBytes } from "../../packages/core/src/bytes.ts";

const WS_URL =
  process.argv[2] ?? process.env.AUDIT_WS_URL ?? "ws://127.0.0.1:18787/v1/ws";

interface Caps {
  platform: string;
  uaFamily: string;
  nativeShell: boolean;
  secureContext: boolean;
  fsAccess: boolean;
  sw: boolean;
  swDownload: boolean;
  saveStrategies: string[];
  deviceMemoryGB: number;
  storageQuotaMB: number;
  screen: string;
}

const HOST_CAPS: Caps = {
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

const GUEST_CAPS: Caps = {
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

type Message = { type: string } & Record<string, unknown>;

const STEP_TIMEOUT_MS = 5_000;
const SESSION_TIMEOUT_MS = 20_000;

function fail(message: string): never {
  console.error(`CLIENT FAIL ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`CLIENT OK ${message}`);
}

class Client {
  readonly label: string;
  readonly messages: Message[] = [];
  private readonly ws: WebSocket;

  constructor(label: string) {
    this.label = label;
    this.ws = new WebSocket(WS_URL, { handshakeTimeout: STEP_TIMEOUT_MS });
    this.ws.on("message", (data) => {
      try {
        this.messages.push(JSON.parse(String(data)) as Message);
      } catch {
        fail(`${label}: server sent non-JSON frame`);
      }
    });
    this.ws.on("error", (error) =>
      fail(`${label}: socket error: ${error.message}`),
    );
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.label}: open timeout`)),
        STEP_TIMEOUT_MS,
      );
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ v: 1, ...message }));
  }

  async waitFor(type: string, timeoutMs = STEP_TIMEOUT_MS): Promise<Message> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find((message) => message.type === type);
      if (found) return found;
      if (Date.now() - started > timeoutMs) {
        fail(
          `${this.label}: timeout waiting for ${type}; got [${this.messages.map((m) => m.type).join(", ")}]`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.ws.close();
  }
}

const overall = setTimeout(
  () => fail(`session exceeded ${SESSION_TIMEOUT_MS} ms`),
  SESSION_TIMEOUT_MS,
);
overall.unref?.();

const host = new Client("host");
const guest = new Client("guest");

try {
  await host.open();
  await guest.open();
  ok(`connected ${WS_URL}`);

  const roomId = base32Encode(randomBytes(16));
  host.send({ type: "hello", clientCaps: HOST_CAPS });
  host.send({ type: "create", roomId, hostCaps: HOST_CAPS });
  const created = await host.waitFor("created");
  if (created.roomId !== roomId)
    fail(`created.roomId mismatch: ${String(created.roomId)}`);
  ok(`created roomId=${roomId} code=${String(created.code)}`);
  const turn = created.turn as
    | { uris?: string[]; username?: string; credential?: string; ttl?: number }
    | undefined;
  if (turn?.username && Array.isArray(turn.uris) && turn.credential) {
    ok(
      `turn credential issued (username=${turn.username}, ttl=${String(turn.ttl)}, uris=${turn.uris.join(",")})`,
    );
  } else {
    ok("no turn credential (TURN_URIS unset on this server)");
  }

  guest.send({ type: "hello", clientCaps: GUEST_CAPS });
  guest.send({
    type: "join",
    roomId,
    guestCaps: GUEST_CAPS,
    guestNonce: "audit-nonce-0123456789",
  });
  const joinRequest = await host.waitFor("join_request");
  ok(`join_request guestId=${String(joinRequest.guestId)}`);

  host.send({ type: "approve", guestId: joinRequest.guestId });
  const [hostJoinOk, guestJoinOk] = await Promise.all([
    host.waitFor("join_ok"),
    guest.waitFor("join_ok"),
  ]);
  ok(
    `join_ok host↔guest peerCaps=${String(hostJoinOk.peerCaps?.constructor?.name ?? "object")}/${String((guestJoinOk.peerCaps as Caps | undefined)?.uaFamily)}`,
  );

  // A few messages in both directions, comparable to the real trickle-ICE traffic.
  for (const seq of [1, 2, 3]) {
    host.send({
      type: "signal",
      to: joinRequest.guestId,
      payload: { k: "offer", sdp: `v=0\r\na=audit-host-${seq}\r\n` },
    });
    await guest.waitFor("signal");
    guest.send({
      type: "signal",
      to: "host",
      payload: { k: "answer", sdp: `v=0\r\na=audit-guest-${seq}\r\n` },
    });
    await host.waitFor("signal");
  }
  ok("signaled host→guest and guest→host (3 each)");

  host.send({ type: "close", roomId });
  const closed = await guest.waitFor("room_closed");
  ok(`room_closed reason=${String(closed.reason)}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  host.close();
  guest.close();
  clearTimeout(overall);
}

console.log("CLIENT PASS");
process.exit(0);
