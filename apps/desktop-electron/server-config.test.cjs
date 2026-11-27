// Unit tests for the Electron shell's server-address normalisation.
// Run with: node --test apps/desktop-electron/server-config.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  OFFICIAL_ORIGIN,
  OFFICIAL_SIGNALING_URL,
  normalizeServerInput,
  loadSavedServer,
  saveServer,
  clearSavedServer,
} = require("./server-config.cjs");

test("official instance derives its wss endpoint", () => {
  assert.deepEqual(normalizeServerInput("https://file.time-pack.com"), {
    origin: "https://file.time-pack.com",
    signalingUrl: "wss://file.time-pack.com/v1/ws",
  });
});

test("trailing slash, path and query are stripped", () => {
  for (const input of [
    "https://file.time-pack.com/",
    "https://file.time-pack.com/some/path?x=1#frag",
    "  https://file.time-pack.com  ",
  ]) {
    assert.deepEqual(normalizeServerInput(input), {
      origin: "https://file.time-pack.com",
      signalingUrl: "wss://file.time-pack.com/v1/ws",
    });
  }
});

test("http origins keep a non-default port and derive ws", () => {
  assert.deepEqual(normalizeServerInput("http://127.0.0.1:8788"), {
    origin: "http://127.0.0.1:8788",
    signalingUrl: "ws://127.0.0.1:8788/v1/ws",
  });
});

test("default ports and host case are normalised", () => {
  assert.deepEqual(normalizeServerInput("HTTPS://File.Time-Pack.com:443"), {
    origin: "https://file.time-pack.com",
    signalingUrl: "wss://file.time-pack.com/v1/ws",
  });
  assert.deepEqual(normalizeServerInput("http://Example.com:80"), {
    origin: "http://example.com",
    signalingUrl: "ws://example.com/v1/ws",
  });
});

test("a pasted wss/ws URL is normalised back to its origin", () => {
  assert.deepEqual(normalizeServerInput("wss://file.time-pack.com/v1/ws"), {
    origin: "https://file.time-pack.com",
    signalingUrl: "wss://file.time-pack.com/v1/ws",
  });
  assert.deepEqual(normalizeServerInput("ws://127.0.0.1:8788/v1/ws"), {
    origin: "http://127.0.0.1:8788",
    signalingUrl: "ws://127.0.0.1:8788/v1/ws",
  });
});

test("IPv6 hosts keep their brackets", () => {
  assert.deepEqual(normalizeServerInput("http://[::1]:8788"), {
    origin: "http://[::1]:8788",
    signalingUrl: "ws://[::1]:8788/v1/ws",
  });
});

test("invalid input is rejected with a Chinese message", () => {
  const cases = [
    ["", /请输入服务器地址/],
    ["   ", /请输入服务器地址/],
    ["file.time-pack.com", /地址格式不正确/],
    ["https://", /地址格式不正确/],
    ["ftp://example.com", /只支持 http/],
    ["javascript:alert(1)", /只支持 http/],
    ["https://user:pass@example.com", /不能包含用户名或密码/],
    ["https://exa mple.com", /不能包含空格/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => normalizeServerInput(input), pattern, input);
  }
});

test("the saved choice round-trips and survives a corrupt file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crossfile-electron-"));
  const file = path.join(dir, "server-settings.json");
  try {
    assert.equal(loadSavedServer(file), null);
    saveServer(file, normalizeServerInput("https://files.example.com/"));
    assert.deepEqual(loadSavedServer(file), {
      origin: "https://files.example.com",
      signalingUrl: "wss://files.example.com/v1/ws",
    });
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(payload.origin, "https://files.example.com");
    assert.equal(payload.signalingUrl, "wss://files.example.com/v1/ws");

    fs.writeFileSync(file, "{ not json");
    assert.equal(loadSavedServer(file), null);

    clearSavedServer(file);
    assert.equal(loadSavedServer(file), null);
    // A second reset must not throw.
    clearSavedServer(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("constants match the official instance", () => {
  assert.equal(OFFICIAL_ORIGIN, "https://file.time-pack.com");
  assert.equal(OFFICIAL_SIGNALING_URL, "wss://file.time-pack.com/v1/ws");
});
