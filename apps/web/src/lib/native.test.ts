import { beforeEach, describe, expect, it, vi } from "vitest";

/** The bridge reads `window` lazily, so a plain stub is enough for unit tests. */
interface FakeWindow {
  __CROSSFILE_NATIVE__?: boolean;
  __CROSSFILE_SIGNALING_URL__?: string;
  __TAURI__?: {
    core: { invoke: ReturnType<typeof vi.fn> };
    event: { listen: ReturnType<typeof vi.fn> };
  };
  __TAURI_INTERNALS__?: unknown;
}

let fakeWindow: FakeWindow;
let listenHandlers: Map<string, (event: { payload: unknown }) => void>;

function installFakeTauri(): { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "save_open") return 7;
      if (command === "save_close") return "/home/me/Downloads/demo.bin";
      void args;
      return undefined;
    },
  );
  listenHandlers = new Map();
  const listen = vi.fn(
    async (
      event: string,
      handler: (nativeEvent: { payload: unknown }) => void,
    ) => {
      listenHandlers.set(event, handler);
      return () => listenHandlers.delete(event);
    },
  );
  fakeWindow.__TAURI__ = { core: { invoke }, event: { listen } };
  fakeWindow.__TAURI_INTERNALS__ = {};
  fakeWindow.__CROSSFILE_NATIVE__ = true;
  return { invoke };
}

beforeEach(() => {
  fakeWindow = {};
  (globalThis as unknown as { window: FakeWindow }).window = fakeWindow;
  (
    globalThis as unknown as { location: { protocol: string; host: string } }
  ).location = {
    protocol: "https:",
    host: "room.example",
  };
});

describe("native shell detection", () => {
  it("is off in a plain browser", async () => {
    const { isNativeShell } = await import("./native.js");
    expect(isNativeShell()).toBe(false);
  });

  it("marks the shell when Tauri internals exist", async () => {
    installFakeTauri();
    const { isNativeShell, markNativeShell } = await import("./native.js");
    markNativeShell();
    expect(isNativeShell()).toBe(true);
  });
});

describe("native save sink", () => {
  it("opens, writes by offset (JSON-safe bytes) and closes to a path", async () => {
    const { invoke } = installFakeTauri();
    const { createNativeSink } = await import("./native.js");
    const sink = createNativeSink();
    await sink.open("demo.bin");
    const bytes = new Uint8Array([104, 105]);
    await sink.write(0, bytes);
    await sink.write(1024, bytes);
    const path = await sink.close();

    expect(path).toBe("/home/me/Downloads/demo.bin");
    expect(invoke).toHaveBeenNthCalledWith(1, "save_open", {
      name: "demo.bin",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "save_write", {
      handle: 7,
      offset: 0,
      bytes: [104, 105],
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "save_write", {
      handle: 7,
      offset: 1024,
      bytes: [104, 105],
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "save_close", { handle: 7 });
  });

  it("rejects writes after close and aborts open handles", async () => {
    installFakeTauri();
    const { createNativeSink } = await import("./native.js");
    const sink = createNativeSink();
    await sink.open("a.bin");
    await sink.close();
    await expect(sink.write(0, new Uint8Array([1]))).rejects.toThrow();

    const second = createNativeSink();
    await second.open("b.bin");
    await second.abort();
    expect(fakeWindow.__TAURI__!.core.invoke).toHaveBeenCalledWith(
      "save_abort",
      { handle: 7 },
    );
  });
});

describe("transfer-active flag", () => {
  it("forwards the flag to the shell and swallows IPC failures", async () => {
    const { invoke } = installFakeTauri();
    const { setTransferActive } = await import("./native.js");
    await setTransferActive(true);
    expect(invoke).toHaveBeenCalledWith("set_transfer_active", {
      active: true,
    });

    invoke.mockRejectedValueOnce(new Error("no shell"));
    await expect(setTransferActive(false)).resolves.toBeUndefined();
  });
});

describe("native window/menu hooks", () => {
  it("ends the room from the menu and confirms a close while idle", async () => {
    const { invoke } = installFakeTauri();
    const { installNativeShellHooks } = await import("./native.js");
    let transferActive = false;
    let ended = 0;
    let newRoom = 0;
    const cleanup = installNativeShellHooks({
      isTransferActive: () => transferActive,
      onEndRoom: () => ended++,
      onNewRoom: () => newRoom++,
    });
    // Let the async listen() registrations settle.
    await Promise.resolve();
    await Promise.resolve();

    listenHandlers.get("menu-action")?.({ payload: "end-room" });
    listenHandlers.get("menu-action")?.({ payload: "new-room" });
    expect(ended).toBe(1);
    expect(newRoom).toBe(1);

    listenHandlers.get("close-requested")?.({ payload: undefined });
    expect(invoke).toHaveBeenCalledWith("confirm_close", undefined);

    // Busy transfer: the confirmation dialog decides; a "no" must not close.
    transferActive = true;
    const confirm = vi.fn(() => false);
    (globalThis as unknown as { window: { confirm: unknown } }).window.confirm =
      confirm;
    listenHandlers.get("close-requested")?.({ payload: undefined });
    expect(confirm).toHaveBeenCalled();

    cleanup();
  });
});
