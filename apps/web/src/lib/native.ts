/**
 * Tauri desktop shell bridge (docs/desktop.md §4).
 *
 * The shell injects `window.__TAURI__` (withGlobalTauri=true) and sets
 * `window.__CROSSFILE_NATIVE__ = true` via an init script so capability detection
 * advertises the `native` save strategy. Everything here is a no-op in a browser.
 */

interface TauriInvoke {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}
interface TauriEvent {
  listen(
    event: string,
    handler: (event: { payload: unknown }) => void,
  ): Promise<() => void>;
}
interface TauriGlobal {
  core?: TauriInvoke;
  event?: TauriEvent;
}

declare global {
  interface Window {
    __CROSSFILE_NATIVE__?: boolean;
    __CROSSFILE_SIGNALING_URL__?: string;
    __TAURI__?: TauriGlobal;
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isNativeShell(): boolean {
  return typeof window !== "undefined" && window.__CROSSFILE_NATIVE__ === true;
}

/** Called once before React mounts (main.tsx). */
export function markNativeShell(): void {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    window.__CROSSFILE_NATIVE__ = true;
  }
}

function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const api = window.__TAURI__?.core;
  if (!api) return Promise.reject(new Error("Tauri IPC unavailable"));
  return api.invoke<T>(command, args);
}

async function listen(
  event: string,
  handler: (payload: unknown) => void,
): Promise<() => void> {
  const api = window.__TAURI__?.event;
  if (!api) return () => undefined;
  return api.listen(event, (nativeEvent) => handler(nativeEvent.payload));
}

export interface SaveSink {
  open(name: string): Promise<void>;
  write(offset: number, bytes: Uint8Array): Promise<void>;
  close(): Promise<string>;
  abort(): Promise<void>;
}

/** Native random-access file writer backed by the Rust `save_*` commands. */
export function createNativeSink(): SaveSink {
  let handle: number | null = null;
  let closed = false;
  return {
    async open(name: string) {
      handle = await invoke<number>("save_open", { name });
      closed = false;
    },
    async write(offset: number, bytes: Uint8Array) {
      if (handle === null || closed) throw new Error("native sink not open");
      // JSON IPC does not carry Uint8Array; the shell expects Vec<u8>.
      await invoke("save_write", { handle, offset, bytes: Array.from(bytes) });
    },
    async close() {
      if (handle === null || closed) throw new Error("native sink not open");
      closed = true;
      const path = await invoke<string>("save_close", { handle });
      handle = null;
      return path;
    },
    async abort() {
      if (handle === null) return;
      const current = handle;
      handle = null;
      closed = true;
      try {
        await invoke("save_abort", { handle: current });
      } catch {
        // already gone
      }
    },
  };
}

/** Native shell menus / window events. No-op in the browser. */
export function installNativeShellHooks(handlers: {
  isTransferActive: () => boolean;
  onEndRoom: () => void;
  onNewRoom: () => void;
}): () => void {
  if (!isNativeShell()) return () => undefined;
  const cleanups: Array<() => void> = [];
  let disposed = false;

  void listen("close-requested", () => {
    if (!handlers.isTransferActive()) {
      void invoke("confirm_close").catch(() => undefined);
      return;
    }
    const confirmed = window.confirm(
      "正在传输文件，关闭窗口会中断传输并销毁房间。仍然关闭？",
    );
    if (confirmed) void invoke("confirm_close").catch(() => undefined);
  }).then((off) => (disposed ? off() : cleanups.push(off)));

  void listen("menu-action", (payload) => {
    if (payload === "new-room") handlers.onNewRoom();
    if (payload === "end-room") handlers.onEndRoom();
  }).then((off) => (disposed ? off() : cleanups.push(off)));

  return () => {
    disposed = true;
    for (const off of cleanups) off();
  };
}

export async function setTransferActive(active: boolean): Promise<void> {
  if (!isNativeShell()) return;
  try {
    await invoke("set_transfer_active", { active });
  } catch {
    // The bool is a UI guard only; failing to set it must not break a transfer.
  }
}
