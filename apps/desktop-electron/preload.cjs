// Preload bridge: makes the web app believe it runs inside the Tauri shell.
//
// apps/web/src/lib/native.ts talks to `window.__TAURI__.core.invoke` and
// `window.__TAURI__.event.listen`, and reads `__CROSSFILE_NATIVE__`. Providing the
// same surface here lets the exact same frontend code use the native save sink.
const { contextBridge, ipcRenderer } = require("electron");

if (process.env.CROSSFILE_SIGNALING_URL) {
  contextBridge.exposeInMainWorld("__CROSSFILE_SIGNALING_URL__", process.env.CROSSFILE_SIGNALING_URL);
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
      return Promise.resolve(() => ipcRenderer.removeListener(event, listener));
    },
  },
});
