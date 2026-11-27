// Server-address normalisation and persistence for the Electron shell.
//
// A self-hoster points CrossFile at their own instance by entering that server's
// origin; the Go single binary serves the web app and `/v1/ws` on the same
// origin, so the signaling URL is derived from it. Only the address is stored —
// there are no secrets in this file.
const fs = require("node:fs");
const path = require("node:path");

const OFFICIAL_ORIGIN = "https://file.time-pack.com";
const OFFICIAL_SIGNALING_URL = "wss://file.time-pack.com/v1/ws";
const SETTINGS_FILE = "server-settings.json";
const SETTINGS_VERSION = 1;

/**
 * Turn user input into `{ origin, signalingUrl }`.
 *
 * Accepts an `http(s)://` origin (trailing slash/path/query are dropped; a path
 * is ignored because the server serves the app at `/`) or a bare
 * `ws(s)://…/v1/ws` URL, which is converted back to its origin.
 *
 * @param {unknown} raw
 * @returns {{ origin: string, signalingUrl: string }}
 */
function normalizeServerInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) throw new Error("请输入服务器地址");
  if (/\s/.test(input)) throw new Error("服务器地址不能包含空格或换行");

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(
      "地址格式不正确：请填写 https://服务器地址（例如 https://file.time-pack.com）",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("服务器地址不能包含用户名或密码");
  }

  let scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "ws" || scheme === "wss") {
    // A pasted signaling URL: keep its host, derive the http(s) origin.
    scheme = scheme === "wss" ? "https" : "http";
  } else if (scheme !== "http" && scheme !== "https") {
    throw new Error(
      "只支持 http:// 或 https:// 地址（本地开发可用 http://），也可以直接填写 wss://…/v1/ws",
    );
  }
  if (!parsed.hostname) throw new Error("地址缺少服务器主机名");

  // `parsed.host` keeps an explicit non-default port and lowercases the host
  // (including `[::1]` brackets for IPv6); path/query/fragment are dropped.
  const origin = `${scheme}://${parsed.host}`;
  const signalingUrl = `${scheme === "https" ? "wss" : "ws"}://${parsed.host}/v1/ws`;
  return { origin, signalingUrl };
}

/**
 * Read the saved server choice. A missing, unreadable or invalid file counts as
 * "nothing saved" so a corrupt config can never lock the user out of the app.
 *
 * @param {string} filePath
 * @returns {{ origin: string, signalingUrl: string } | null}
 */
function loadSavedServer(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.origin !== "string"
  )
    return null;
  try {
    return normalizeServerInput(parsed.origin);
  } catch {
    return null;
  }
}

/**
 * Persist the choice atomically (tmp file + rename) so a crash mid-write cannot
 * leave a truncated config behind.
 *
 * @param {string} filePath
 * @param {{ origin: string, signalingUrl: string }} server
 */
function saveServer(filePath, server) {
  const payload = {
    version: SETTINGS_VERSION,
    origin: server.origin,
    signalingUrl: server.signalingUrl,
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
  return payload;
}

/** Remove the saved choice; a missing file is success. */
function clearSavedServer(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

module.exports = {
  OFFICIAL_ORIGIN,
  OFFICIAL_SIGNALING_URL,
  SETTINGS_FILE,
  SETTINGS_VERSION,
  normalizeServerInput,
  loadSavedServer,
  saveServer,
  clearSavedServer,
};
