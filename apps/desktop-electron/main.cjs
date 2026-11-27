// CrossFile Linux desktop shell (Electron).
//
// Why this exists: Tauri 2 on Linux uses the distro WebKitGTK, and Ubuntu's build
// has WebRTC disabled (`RTCPeerConnection` is undefined) — see ADR 0008. Electron
// bundles Chromium, so the same frontend can transfer files on Linux. Windows and
// macOS keep the Tauri shell (system WebView supports WebRTC).
//
// IPC surface matches docs/desktop.md §4 exactly: save_open / save_write /
// save_close / save_abort / set_transfer_active / confirm_close.
//
// Server address: the web app is loaded from the server origin (the Go single
// binary serves the web app and /v1/ws on the same origin). The user picks that
// origin once on a shell-owned settings page; the choice is stored in the
// Electron userData dir (server-config.cjs) and survives restarts. An explicit
// CROSSFILE_URL / CROSSFILE_SIGNALING_URL keeps working for self-hosted builds.
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const {
  OFFICIAL_ORIGIN,
  OFFICIAL_SIGNALING_URL,
  SETTINGS_FILE,
  normalizeServerInput,
  loadSavedServer,
  saveServer,
  clearSavedServer,
} = require("./server-config.cjs");

const PRIVACY_URL =
  process.env.CROSSFILE_PRIVACY_URL || `${OFFICIAL_ORIGIN}/privacy`;
const HOMEPAGE_URL =
  process.env.CROSSFILE_HOMEPAGE_URL || `${OFFICIAL_ORIGIN}/`;

/** Runtime overrides kept for self-hosted builds / headed dev runs. */
const APP_URL_ENV = (process.env.CROSSFILE_URL || "").trim();
const SIGNALING_URL_ENV = (process.env.CROSSFILE_SIGNALING_URL || "").trim();

const SETTINGS_PAGE = path.join(__dirname, "settings.html");
const SETTINGS_MENU_ID = "server-settings";

// The agent/CI sandbox cannot use Chromium's setuid sandbox; harmless for normal runs.
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");

const handles = new Map();
let nextHandle = 1;
let transferActive = false;
let mainWindow = null;
let appMenu = null;

/** Saved choice from server-settings.json (null until loaded / when absent). */
let savedServer = null;
/** True when no saved value and no env override: the settings page is the start screen. */
let firstRun = false;
/** Last bundled-app page shown in the window (where 取消 returns to). */
let lastAppUrl = null;
/** Populated when the saved server could not be loaded, surfaced by the settings page. */
let lastLoadError = null;

// ---------------------------------------------------------------------------
// Server setting resolution
// ---------------------------------------------------------------------------

function settingsFilePath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

/**
 * Resolve the explicit runtime override (CROSSFILE_URL / CROSSFILE_SIGNALING_URL).
 * The app URL keeps its full value (a dev/self-host deep link may carry a path);
 * the signaling URL comes from CROSSFILE_SIGNALING_URL or is derived from it.
 */
function envServer() {
  if (!APP_URL_ENV && !SIGNALING_URL_ENV) return null;
  let base;
  try {
    base = normalizeServerInput(APP_URL_ENV || SIGNALING_URL_ENV);
  } catch {
    base = normalizeServerInput(OFFICIAL_ORIGIN);
  }
  let signalingUrl = base.signalingUrl;
  if (SIGNALING_URL_ENV) {
    try {
      signalingUrl = normalizeServerInput(SIGNALING_URL_ENV).signalingUrl;
    } catch {
      // Invalid override: keep the derived endpoint instead of failing to start.
    }
  }
  return {
    origin: base.origin,
    signalingUrl,
    appUrl: APP_URL_ENV || base.origin,
    source: "env",
    isOfficial: base.origin === OFFICIAL_ORIGIN,
  };
}

/** Precedence: env override > saved choice > official instance. */
function effectiveServer() {
  const env = envServer();
  if (env) return env;
  if (savedServer) {
    return {
      ...savedServer,
      appUrl: savedServer.origin,
      source: "saved",
      isOfficial: savedServer.origin === OFFICIAL_ORIGIN,
    };
  }
  return {
    origin: OFFICIAL_ORIGIN,
    signalingUrl: OFFICIAL_SIGNALING_URL,
    appUrl: OFFICIAL_ORIGIN,
    source: "default",
    isOfficial: true,
  };
}

function settingsSnapshot() {
  const server = effectiveServer();
  return {
    origin: server.origin,
    signalingUrl: server.signalingUrl,
    source: server.source,
    isOfficial: server.isOfficial,
    officialOrigin: OFFICIAL_ORIGIN,
    officialSignalingUrl: OFFICIAL_SIGNALING_URL,
    firstRun,
    envOverride: Boolean(APP_URL_ENV || SIGNALING_URL_ENV),
    transferActive,
    lastLoadError,
  };
}

// ---------------------------------------------------------------------------
// Window navigation: bundled app <-> shell settings page
// ---------------------------------------------------------------------------

function isSettingsPageUrl(url) {
  return String(url || "").startsWith("file:");
}

function showSettingsPage() {
  if (!mainWindow) return Promise.resolve();
  return mainWindow.loadFile(SETTINGS_PAGE).catch((error) => {
    console.error("[electron] settings page failed to load", error);
  });
}

function showAppPage(server) {
  if (!mainWindow) return;
  lastAppUrl = server.appUrl || server.origin;
  lastLoadError = null;
  console.log("[electron] loading", lastAppUrl);
  void mainWindow.loadURL(lastAppUrl).catch((error) => {
    console.error("[electron] app page failed to load", error);
  });
}

/** Apply a choice immediately. While a transfer is running the change waits for restart. */
function applyServerChoice(server) {
  if (transferActive) return false;
  showAppPage(server);
  return true;
}

function openSettings() {
  if (!mainWindow) return;
  if (transferActive) {
    void dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "CrossFile",
      message: "正在传输文件",
      detail: "传输结束后才能打开服务器设置，以免中断当前传输。",
      buttons: ["好"],
      defaultId: 0,
    });
    return;
  }
  void showSettingsPage();
}

// ---------------------------------------------------------------------------
// Connection test (shell-side, WebSocket against <origin>/v1/ws)
// ---------------------------------------------------------------------------

const MINIMAL_CLIENT_CAPS = {
  platform:
    { win32: "win", darwin: "mac", linux: "linux" }[process.platform] ||
    "unknown",
  uaFamily: "unknown",
  nativeShell: true,
  secureContext: false,
  fsAccess: true,
  sw: false,
  swDownload: false,
  saveStrategies: ["native"],
  screen: "desktop",
};

/** Open the socket, send a minimal hello, report the handshake, close immediately. */
function testSignalingConnection(signalingUrl) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, message: "连接超时（5 秒内没有响应）" }),
      5000,
    );

    if (typeof WebSocket !== "function") {
      finish({
        ok: false,
        message: "当前 Electron 运行时不支持 WebSocket，无法测试连接",
      });
      return;
    }
    try {
      socket = new WebSocket(signalingUrl);
    } catch (error) {
      finish({ ok: false, message: `无法发起连接：${error.message}` });
      return;
    }
    socket.addEventListener("open", () => {
      try {
        socket.send(
          JSON.stringify({
            v: 2,
            type: "hello",
            clientCaps: MINIMAL_CLIENT_CAPS,
          }),
        );
      } catch {
        // The reachability handshake already succeeded.
      }
      finish({
        ok: true,
        message: "连接成功",
        latencyMs: Date.now() - started,
      });
    });
    socket.addEventListener("error", () =>
      finish({
        ok: false,
        message: "无法连接：请检查地址、网络或服务器是否在运行",
      }),
    );
    socket.addEventListener("close", () =>
      finish({ ok: false, message: "连接被服务器关闭" }),
    );
  });
}

// ---------------------------------------------------------------------------
// IPC: server settings (only the local settings.html page may call these)
// ---------------------------------------------------------------------------

function isSettingsSender(event) {
  let url = "";
  try {
    url = event.senderFrame?.url || event.sender.getURL();
  } catch {
    return false;
  }
  return String(url || "").startsWith("file:");
}

ipcMain.on("crossfile:signaling-url", (event) => {
  event.returnValue = effectiveServer().signalingUrl;
});

ipcMain.handle("settings:get", (event) => {
  if (!isSettingsSender(event))
    return { ok: false, error: "无权读取服务器设置" };
  return { ok: true, settings: settingsSnapshot() };
});

ipcMain.handle("settings:save", (event, raw) => {
  if (!isSettingsSender(event))
    return { ok: false, error: "无权修改服务器设置" };
  let server;
  try {
    server = normalizeServerInput(raw);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  try {
    saveServer(settingsFilePath(), server);
  } catch (error) {
    return { ok: false, error: `无法保存设置：${error.message}` };
  }
  savedServer = server;
  firstRun = false;
  const applied = applyServerChoice(effectiveServer());
  return {
    ok: true,
    applied,
    settings: settingsSnapshot(),
    message: applied
      ? "已保存，正在连接…"
      : "已保存；当前正在传输文件，重启应用后生效。",
  };
});

ipcMain.handle("settings:reset", (event) => {
  if (!isSettingsSender(event))
    return { ok: false, error: "无权修改服务器设置" };
  try {
    clearSavedServer(settingsFilePath());
  } catch (error) {
    return { ok: false, error: `无法恢复官方实例：${error.message}` };
  }
  savedServer = null;
  firstRun = false;
  const applied = applyServerChoice(effectiveServer());
  return {
    ok: true,
    applied,
    settings: settingsSnapshot(),
    message: applied
      ? `已恢复官方实例 ${OFFICIAL_ORIGIN}，正在连接…`
      : "已恢复官方实例；当前正在传输文件，重启应用后生效。",
  };
});

ipcMain.handle("settings:test", async (event, raw) => {
  if (!isSettingsSender(event)) return { ok: false, error: "无权测试服务器" };
  let server;
  try {
    server = normalizeServerInput(raw);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const result = await testSignalingConnection(server.signalingUrl);
  return {
    ...result,
    origin: server.origin,
    signalingUrl: server.signalingUrl,
  };
});

ipcMain.handle("settings:cancel", (event) => {
  if (!isSettingsSender(event))
    return { ok: false, error: "无权关闭服务器设置" };
  if (firstRun) {
    app.quit();
    return { ok: true, closed: true };
  }
  if (lastLoadError) {
    // Returning to a server we just failed to load would bounce straight back
    // here; keep the user on the settings page with an explanation instead.
    return {
      ok: true,
      closed: false,
      stayed: true,
      message: "当前服务器仍无法访问，请修改地址或恢复官方实例。",
    };
  }
  showAppPage(effectiveServer());
  return { ok: true, closed: false };
});

// ---------------------------------------------------------------------------
// Native save sink (unchanged, docs/desktop.md §4)
// ---------------------------------------------------------------------------

function safeFileName(raw) {
  const base = String(raw ?? "")
    .split(/[/\\]/)
    .filter(Boolean)
    .pop();
  const cleaned = (base ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return cleaned || "crossfile-download.bin";
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || "file";
  let candidate = path.join(dir, name);
  for (let index = 1; fs.existsSync(candidate); index += 1) {
    candidate = path.join(dir, `${stem} (${index})${ext}`);
  }
  return candidate;
}

function saveDir() {
  const dir = app.getPath("downloads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle("save_open", (_event, { name }) => {
  const target = uniquePath(saveDir(), safeFileName(name));
  const fd = fs.openSync(target, "w");
  const handle = nextHandle++;
  handles.set(handle, { fd, path: target });
  return handle;
});

ipcMain.handle("save_write", (_event, { handle, offset, bytes }) => {
  const entry = handles.get(handle);
  if (!entry) throw new Error(`unknown save handle ${handle}`);
  const buffer = Buffer.from(bytes);
  let written = 0;
  while (written < buffer.length) {
    written += fs.writeSync(
      entry.fd,
      buffer,
      written,
      buffer.length - written,
      offset + written,
    );
  }
});

ipcMain.handle("save_close", (_event, { handle }) => {
  const entry = handles.get(handle);
  if (!entry) throw new Error(`unknown save handle ${handle}`);
  handles.delete(handle);
  fs.closeSync(entry.fd);
  return entry.path;
});

ipcMain.handle("save_abort", (_event, { handle }) => {
  const entry = handles.get(handle);
  if (!entry) return;
  handles.delete(handle);
  try {
    fs.closeSync(entry.fd);
  } catch {
    // already closed
  }
});

ipcMain.handle("set_transfer_active", (_event, { active }) => {
  transferActive = Boolean(active);
  // Opening the settings page would destroy the page that owns the transfer.
  const item = appMenu?.getMenuItemById(SETTINGS_MENU_ID);
  if (item) item.enabled = !transferActive;
});

ipcMain.handle("confirm_close", () => {
  app.quit();
});

// ---------------------------------------------------------------------------
// Native menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "房间",
      submenu: [
        {
          label: "新建房间",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow?.webContents.send("menu-action", "new-room"),
        },
        {
          label: "结束房间",
          accelerator: "CmdOrCtrl+W",
          click: () => mainWindow?.webContents.send("menu-action", "end-room"),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    {
      label: "设置",
      submenu: [
        {
          id: SETTINGS_MENU_ID,
          label: "服务器地址…",
          accelerator: "CmdOrCtrl+,",
          click: () => openSettings(),
        },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "隐私说明",
          click: () => void shell.openExternal(PRIVACY_URL),
        },
        {
          label: "项目主页",
          click: () => void shell.openExternal(HOMEPAGE_URL),
        },
      ],
    },
  ]);
  appMenu = menu;
  return menu;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    center: true,
    title: "CrossFile",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  Menu.setApplicationMenu(buildMenu());
  mainWindow.on("close", (event) => {
    if (!transferActive) return;
    if (process.env.CROSSFILE_TRANSFER_AUTOCLOSE === "1") return;
    event.preventDefault();
    mainWindow.webContents.send("close-requested");
  });
  mainWindow.webContents.on("did-finish-load", () => {
    const url = mainWindow.webContents.getURL();
    console.log("[electron] loaded", url);
    if (isSettingsPageUrl(url)) return;
    // Keep lastLoadError: Chromium also reports did-finish-load for its error
    // page, and the settings page opened by did-fail-load still needs it.
    lastAppUrl = url;
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 = ERR_ABORTED (a newer navigation superseded this one).
      if (code === -3 || isSettingsPageUrl(url)) return;
      console.log("[electron] load failed", code, description, url);
      lastLoadError = {
        origin: effectiveServer().origin,
        message: `${description}（${code}）`,
      };
      // Keep the setting reachable while the saved server is down.
      void showSettingsPage();
    },
  );
}

app.whenReady().then(() => {
  savedServer = loadSavedServer(settingsFilePath());
  firstRun = !savedServer && !envServer();
  createWindow();
  if (firstRun) void showSettingsPage();
  else showAppPage(effectiveServer());
});

app.on("window-all-closed", () => app.quit());
