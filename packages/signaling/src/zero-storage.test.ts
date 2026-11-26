/**
 * Zero-storage audit (docs/02 §7, docs/01 AC8): the signaling package writes nothing to disk,
 * keeps no database, and never logs requests. Static source assertions plus a live console spy.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomIdentity } from "@crossfile/core/ids";
import { createSignalingServer } from "./index.js";
import { redactIp } from "./log.js";
import { ADMIN_CAPS, MEMBER_CAPS, sleep, TestClient } from "./test-support.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const EXCLUDED_FILES = new Set(["dev.ts", "test-support.ts"]);

const sourceFiles = readdirSync(SRC_DIR)
  .filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !EXCLUDED_FILES.has(name),
  )
  .sort();

function readSource(name: string): string {
  return readFileSync(join(SRC_DIR, name), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("zero storage (docs/02 §7)", () => {
  it("has no filesystem or database imports (read-only static hosting excepted)", () => {
    for (const file of sourceFiles) {
      const source = readSource(file);
      // static.ts is the one place allowed to touch the filesystem, and only to read the
      // built web app (production single-origin hosting, docs/02 §7).
      if (file !== "static.ts") {
        expect(source, file).not.toMatch(
          /from\s+["']node:fs(?:\/promises)?["']/,
        );
      } else {
        expect(source, file).not.toMatch(
          /\b(?:writeFile|appendFile|createWriteStream|mkdir|rm|unlink|rename|truncate|chmod)\w*\s*\(/,
        );
      }
      expect(source, file).not.toMatch(/require\(\s*["']node:fs["']\s*\)/);
      expect(source, file).not.toMatch(
        /from\s+["'](?:pg|mysql2?|sqlite3?|better-sqlite3|redis|ioredis|mongoose|mongodb|knex|prisma|@prisma\/client|drizzle-orm|level|lowdb)["']/,
      );
      expect(source, file).not.toMatch(
        /\b(?:writeFile|appendFile|createWriteStream|mkdirSync|writeFileSync)\s*\(/,
      );
    }
  });

  it("never writes request or access logs", () => {
    for (const file of sourceFiles) {
      const source = readSource(file);
      expect(source, file).not.toMatch(/console\.(?:log|info|warn|debug)\s*\(/);
      // Error-level output is allowed, and only the logger module may emit it.
      if (file !== "log.ts") expect(source, file).not.toMatch(/console\.error/);
      expect(source, file).not.toMatch(/access[-_]?log/i);
      expect(source, file).not.toMatch(/whatwg-fetch|morgan|pino|winston/i);
    }
    // log.ts is the only logger and it only emits error level output.
    const logger = readSource("log.ts");
    expect(logger).toMatch(/export function logError/);
    // Every logError call site passes a constant scope, never user data.
    for (const file of sourceFiles.filter((name) => name !== "log.ts")) {
      expect(readSource(file), file).not.toMatch(/logError\((?!")/);
    }
  });

  it("keeps rooms free of peer network fields and message history", () => {
    const rooms = readSource("rooms.ts");
    expect(rooms).not.toMatch(/userAgent|user-agent|user_agent/i);
    expect(rooms).not.toMatch(/\bip\s*:/i);
    expect(rooms).not.toMatch(/\bheaders\b/i);
    // The connection IP exists in exactly one place: the in-memory rate-limit key.
    const server = readSource("server.ts");
    expect(server).not.toMatch(/req(?:uest)?\.headers/);
  });

  it("declares no filesystem or database dependencies", () => {
    const manifestPath = join(SRC_DIR, "..", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const banned of [
      "pg",
      "mysql2",
      "sqlite3",
      "better-sqlite3",
      "redis",
      "ioredis",
      "mongoose",
      "mongodb",
      "knex",
      "prisma",
      "@prisma/client",
      "drizzle-orm",
      "lowdb",
    ]) {
      expect(declared).not.toHaveProperty(banned);
    }
  });

  it("stays silent (no console output) during a full signaling session", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const server = createSignalingServer({ port: 0, host: "127.0.0.1" });
    const { port } = await server.start();
    const host = await TestClient.open(port);
    const guest = await TestClient.open(port);
    try {
      const { roomId } = createRoomIdentity();
      host.send({ v: 2, type: "hello", clientCaps: ADMIN_CAPS });
      host.send({
        v: 2,
        type: "create",
        roomId,
        caps: ADMIN_CAPS,
        name: "地检机",
      });
      const created = await host.next("created");
      guest.send({
        v: 2,
        type: "join",
        roomId: created.roomId,
        caps: MEMBER_CAPS,
        nonce: "member-nonce-0123456789",
      });
      const request = await host.next("join_request");
      host.send({ v: 2, type: "approve", memberId: request.memberId });
      await guest.next("join_ok");
      await host.next("members");
      host.send({
        v: 2,
        type: "signal",
        to: request.memberId,
        payload: { k: "offer", sdp: "v=0" },
      });
      await guest.next("signal");
      host.send({ v: 2, type: "heartbeat", roomId });
      await sleep(20);
      host.send({ v: 2, type: "close", roomId });
      await guest.next("room_closed");
      await guest.closed();
    } finally {
      await host.close();
      await guest.close();
      await server.stop();
    }
    const output = spies.reduce(
      (total, spy) => total + spy.mock.calls.length,
      0,
    );
    expect(output).toBe(0);
  });
});

describe("log redaction (docs/02 §7)", () => {
  it("masks the first two segments of any peer address", () => {
    expect(redactIp("203.0.113.45")).toBe("***.***.113.45");
    expect(redactIp("::ffff:198.51.100.7")).toBe("***.***.100.7");
    expect(redactIp(undefined)).toBe("unknown");
    expect(redactIp("2001:db8::1")).toContain("****");
    expect(redactIp("not-an-ip")).toBe("***");
  });
});
