/**
 * Real signaling session for the zero-storage audit (docs/01 AC8, docs/02 §7, v2).
 *
 * Unlike `scripts/smoke-signaling.mts` (which starts an in-process server on port 0), this
 * client only speaks to a *separate* server over `ws://127.0.0.1:<port>/v1/ws`, so the audit
 * script can strace the server process while a complete v2 session runs through it:
 * create → join ×2 → approve → profile (members broadcast) → arbitrary-member signals →
 * close. It exercises every message shape that touches room state, which is exactly what
 * the zero-storage claim has to survive (ADR 0010 §AC15: `members`/`profile` stay in memory).
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

const ADMIN_CAPS: Caps = {
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

const MEMBER_CAPS: Caps = {
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

const STEP_TIMEOUT_MS = 8_000;
const SESSION_TIMEOUT_MS = 40_000;

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
  private closed = false;

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
    this.ws.on("close", () => {
      this.closed = true;
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
    this.ws.send(JSON.stringify({ v: 2, ...message }));
  }

  async waitFor(
    type: string,
    predicate: (message: Message) => boolean = () => true,
    timeoutMs = STEP_TIMEOUT_MS,
  ): Promise<Message> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find(
        (message) => message.type === type && predicate(message),
      );
      if (found) return found;
      if (this.closed && type !== "room_closed") {
        fail(
          `${this.label}: socket closed while waiting for ${type}; got [${this.messages.map((m) => m.type).join(", ")}]`,
        );
      }
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

const admin = new Client("admin");
const memberA = new Client("memberA");
const memberB = new Client("memberB");

try {
  await Promise.all([admin.open(), memberA.open(), memberB.open()]);
  ok(`connected ${WS_URL}`);

  // 1. create -----------------------------------------------------------------
  const roomId = base32Encode(randomBytes(16));
  admin.send({ type: "hello", clientCaps: ADMIN_CAPS });
  admin.send({
    type: "create",
    roomId,
    caps: ADMIN_CAPS,
    name: "审计管理员",
  });
  const created = await admin.waitFor("created");
  if (created.roomId !== roomId)
    fail(`created.roomId mismatch: ${String(created.roomId)}`);
  const adminId = String(created.selfId);
  if (!adminId) fail("created.selfId missing");
  const code = String(created.code);
  if (!/^[0-9]{6}$/.test(code)) fail(`created.code invalid: ${code}`);
  if (typeof created.rejoinToken !== "string" || created.rejoinToken === "")
    fail("created.rejoinToken missing");
  ok(`created roomId=${roomId} code=${code} adminId=${adminId}`);

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

  // 2. two members join and are approved by the admin --------------------------
  memberA.send({ type: "hello", clientCaps: MEMBER_CAPS });
  memberA.send({
    type: "join",
    roomId,
    caps: MEMBER_CAPS,
    nonce: "audit-nonce-aaaaaaaa",
  });
  const requestA = await admin.waitFor("join_request");
  const memberAId = String(requestA.memberId);
  admin.send({ type: "approve", memberId: memberAId });
  // The admin is not sent join_ok: it observes the approval through the members
  // broadcast; only the joining member receives join_ok (docs/02 v2 §3.4).
  const [adminMembersA, memberAJoinOk] = await Promise.all([
    admin.waitFor("members", (m) =>
      (m.members as Array<{ id: string }>).some(
        (entry) => entry.id === memberAId,
      ),
    ),
    memberA.waitFor("join_ok"),
  ]);
  ok(
    `member A approved (members=${String((adminMembersA.members as unknown[]).length)}, member selfId=${String(memberAJoinOk.selfId)})`,
  );

  // profile rename -> the server rebroadcasts the member list (no storage).
  memberA.send({ type: "profile", name: "审计成员 A" });
  const renamed = await admin.waitFor("members", (m) =>
    (m.members as Array<{ name: string }>).some(
      (entry) => entry.name === "审计成员 A",
    ),
  );
  ok(
    `profile broadcast (${String((renamed.members as unknown[]).length)} members inc. admin)`,
  );

  memberB.send({ type: "hello", clientCaps: MEMBER_CAPS });
  memberB.send({
    type: "join",
    roomId,
    caps: MEMBER_CAPS,
    nonce: "audit-nonce-bbbbbbbb",
  });
  const requestB = await admin.waitFor(
    "join_request",
    (m) => m.memberId !== memberAId,
  );
  const memberBId = String(requestB.memberId);
  admin.send({ type: "approve", memberId: memberBId });
  await admin.waitFor("members", (m) =>
    (m.members as Array<{ id: string }>).some(
      (entry) => entry.id === memberBId,
    ),
  );
  ok(`second member approved (memberB id=${memberBId})`);

  // 3. arbitrary-member signaling: admin→A, A→admin, A→B -----------------------
  const signal = (from: Client, to: string, tag: string, kind: string) =>
    from.send({
      type: "signal",
      to,
      payload: { k: kind, sdp: `v=0\r\na=audit-${tag}\r\n` },
    });
  signal(admin, memberAId, "admin-a", "offer");
  await memberA.waitFor(
    "signal",
    (m) =>
      (m.payload as { sdp?: string }).sdp?.includes("audit-admin-a") === true,
  );
  signal(memberA, adminId, "a-admin", "answer");
  await admin.waitFor(
    "signal",
    (m) =>
      (m.payload as { sdp?: string }).sdp?.includes("audit-a-admin") === true,
  );
  signal(memberA, memberBId, "a-b", "offer");
  await memberB.waitFor(
    "signal",
    (m) => (m.payload as { sdp?: string }).sdp?.includes("audit-a-b") === true,
  );
  ok("signaled admin→A, A→admin and A→B (arbitrary member routing)");

  // 4. close: every member is told, room leaves memory -------------------------
  admin.send({ type: "close", roomId });
  const closedA = await memberA.waitFor("room_closed");
  const closedB = await memberB.waitFor("room_closed");
  if (closedA.reason !== "admin_close" || closedB.reason !== "admin_close")
    fail(`room_closed reason mismatch: ${String(closedA.reason)}`);
  ok(`room_closed reason=${String(closedA.reason)} (both members)`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  admin.close();
  memberA.close();
  memberB.close();
  clearTimeout(overall);
}

console.log("CLIENT PASS");
process.exit(0);
