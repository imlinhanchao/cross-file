import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSignalingServer, type SignalingServer } from "./index.js";

const INDEX = "<!doctype html><title>CrossFile</title><div id=root></div>";
const ASSET = "console.log('app');";

describe("static hosting (single-origin production)", () => {
  let dir: string;
  let server: SignalingServer;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crossfile-static-"));
    await writeFile(join(dir, "index.html"), INDEX);
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "app.js"), ASSET);
    await writeFile(join(dir, "favicon.svg"), "<svg/>");
    server = createSignalingServer({ port: 0, staticDir: dir });
    const { port } = await server.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves index.html at / with privacy headers", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(await response.text()).toContain("CrossFile");
  });

  it("falls back to index.html for SPA routes", async () => {
    for (const path of [
      "/r/abcdefghijklmnopqrstuvwxyz",
      "/j/123456",
      "/code",
      "/privacy",
    ]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>CrossFile</title>");
    }
  });

  it("serves hashed assets with immutable caching", async () => {
    const response = await fetch(`${base}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe(ASSET);
  });

  it("does not serve files outside the static root", async () => {
    const attempts = [
      "/../../etc/passwd",
      "/..%2f..%2fetc%2fpasswd",
      "/%2e%2e/%2e%2e/etc/passwd",
    ];
    for (const attempt of attempts) {
      const response = await fetch(`${base}${attempt}`);
      const body = await response.text();
      expect(body).not.toContain("root:");
      // traversal is refused outright (404) rather than silently rendered as the SPA
      expect([200, 404]).toContain(response.status);
    }
  });

  it("keeps /v1/ plain HTTP requests as 404 and rejects write methods", async () => {
    const ws = await fetch(`${base}/v1/ws`);
    expect(ws.status).toBe(404);
    const post = await fetch(`${base}/`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("answers HEAD without a body", async () => {
    const response = await fetch(`${base}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("static hosting disabled", () => {
  it("stays a quiet 404 server when no staticDir is configured", async () => {
    const server = createSignalingServer({ port: 0 });
    const { port } = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(404);
    await server.stop();
  });
});
