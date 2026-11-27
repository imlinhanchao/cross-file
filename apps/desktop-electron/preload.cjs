// Preload bridge.
//
// Two pages run in the main window:
//   * the remote web app (CrossFile frontend) — gets the Tauri-compatible bridge
//     from docs/desktop.md §4 plus the shell-resolved signaling URL;
//   * the local server-settings page (settings.html) — gets a narrow settings
//     bridge and nothing else.
// Never expose the settings bridge to the remote page.
const { contextBridge, ipcRenderer } = require("electron");

function isSettingsPage() {
  try {
    return (
      location.protocol === "file:" &&
      location.pathname.endsWith("settings.html")
    );
  } catch {
    return false;
  }
}

if (isSettingsPage()) {
  contextBridge.exposeInMainWorld("crossfileSettings", {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (origin) => ipcRenderer.invoke("settings:save", origin),
    reset: () => ipcRenderer.invoke("settings:reset"),
    test: (origin) => ipcRenderer.invoke("settings:test", origin),
    cancel: () => ipcRenderer.invoke("settings:cancel"),
  });
} else {
  // The main process resolves env override > saved choice > official instance.
  let signalingUrl = "";
  try {
    const value = ipcRenderer.sendSync("crossfile:signaling-url");
    if (typeof value === "string") signalingUrl = value;
  } catch {
    // Fall back to the env override below / same-origin derivation in the web app.
  }
  if (!signalingUrl && process.env.CROSSFILE_SIGNALING_URL) {
    signalingUrl = process.env.CROSSFILE_SIGNALING_URL;
  }
  if (signalingUrl) {
    contextBridge.exposeInMainWorld(
      "__CROSSFILE_SIGNALING_URL__",
      signalingUrl,
    );
  }
  contextBridge.exposeInMainWorld("__CROSSFILE_NATIVE__", true);

  contextBridge.exposeInMainWorld("__TAURI__", {
    core: {
      invoke: (command, args) => ipcRenderer.invoke(command, args),
    },
    event: {
      listen: (event, handler) => {
        const listener = (_nativeEvent, payload) => handler({ payload });
        ipcRenderer.on(event, listener);
        return Promise.resolve(() =>
          ipcRenderer.removeListener(event, listener),
        );
      },
    },
  });
}
