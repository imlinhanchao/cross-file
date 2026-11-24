// CrossFile Linux desktop shell (Electron).
//
// Why this exists: Tauri 2 on Linux uses the distro WebKitGTK, and Ubuntu's build
// has WebRTC disabled (`RTCPeerConnection` is undefined) — see ADR 0008. Electron
// bundles Chromium, so the same frontend can transfer files on Linux. Windows and
// macOS keep the Tauri shell (system WebView supports WebRTC).
//
// IPC surface matches docs/desktop.md §4 exactly: save_open / save_write /
// save_close / save_abort / set_transfer_active / confirm_close.
const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const APP_URL = process.env.CROSSFILE_URL || "http://127.0.0.1:8788";
const PRIVACY_URL = process.env.CROSSFILE_PRIVACY_URL || "https://room.net.time-pack.com/privacy";
const HOMEPAGE_URL = process.env.CROSSFILE_HOMEPAGE_URL || "https://room.net.time-pack.com/";

// The agent/CI sandbox cannot use Chromium's setuid sandbox; harmless for normal runs.
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");

const handles = new Map();
let nextHandle = 1;
let transferActive = false;
let mainWindow = null;

function safeFileName(raw) {
  const base = String(raw ?? "")
    .split(/[/\\]/)
    .filter(Boolean)
    .pop();
  const cleaned = (base ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
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
    written += fs.writeSync(entry.fd, buffer, written, buffer.length - written, offset + written);
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
});

ipcMain.handle("confirm_close", () => {
  app.quit();
});

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: "房间",
      submenu: [
        { label: "新建房间", accelerator: "CmdOrCtrl+N", click: () => mainWindow?.webContents.send("menu-action", "new-room") },
        { label: "结束房间", accelerator: "CmdOrCtrl+W", click: () => mainWindow?.webContents.send("menu-action", "end-room") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    {
      label: "帮助",
      submenu: [
        { label: "隐私说明", click: () => void shell.openExternal(PRIVACY_URL) },
        { label: "项目主页", click: () => void shell.openExternal(HOMEPAGE_URL) },
      ],
    },
  ]);
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
    console.log("[electron] loaded", mainWindow.webContents.getURL());
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.log("[electron] load failed", code, description, url);
  });
  console.log("[electron] loading", APP_URL);
  void mainWindow.loadURL(APP_URL);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
