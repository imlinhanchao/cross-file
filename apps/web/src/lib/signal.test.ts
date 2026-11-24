import { describe, expect, it, vi } from "vitest";

/** signal.ts only reads `window`/`location` at call time, so a stub suffices. */
function stubRuntime(overrides: {
  url?: string;
  stored?: string;
  native?: boolean;
  protocol?: string;
  host?: string;
}): void {
  const globals = globalThis as unknown as {
    window: {
      __CROSSFILE_SIGNALING_URL__?: string;
      __CROSSFILE_NATIVE__?: boolean;
      localStorage?: { getItem(key: string): string | null };
    };
    location: { protocol: string; host: string };
  };
  globals.window = {
    ...(overrides.url ? { __CROSSFILE_SIGNALING_URL__: overrides.url } : {}),
    ...(overrides.native ? { __CROSSFILE_NATIVE__: true } : {}),
    ...(overrides.stored !== undefined
      ? {
          localStorage: {
            getItem: (key: string) =>
              key === "crossfile.signalingUrl" ? overrides.stored! : null,
          },
        }
      : {}),
  };
  globals.location = {
    protocol: overrides.protocol ?? "https:",
    host: overrides.host ?? "room.example",
  };
}

describe("signalingUrl", () => {
  it("prefers the URL injected by the desktop shell", async () => {
    stubRuntime({ url: "ws://127.0.0.1:8788/v1/ws" });
    const { signalingUrl } = await import("./signal.js");
    expect(signalingUrl()).toBe("ws://127.0.0.1:8788/v1/ws");
  });

  it("is same-origin wss on https pages", async () => {
    stubRuntime({ protocol: "https:", host: "room.net.time-pack.com" });
    const { signalingUrl } = await import("./signal.js");
    expect(signalingUrl()).toBe("wss://room.net.time-pack.com/v1/ws");
  });

  it("is ws on http pages (localhost dev)", async () => {
    stubRuntime({ protocol: "http:", host: "127.0.0.1:5173" });
    const { signalingUrl } = await import("./signal.js");
    expect(signalingUrl()).toBe("ws://127.0.0.1:5173/v1/ws");
  });

  it("honours the stored self-host setting", async () => {
    stubRuntime({ stored: "wss://signal.example.com/v1/ws" });
    const { signalingUrl } = await import("./signal.js");
    expect(signalingUrl()).toBe("wss://signal.example.com/v1/ws");
  });

  it("defaults to the local instance inside the desktop shell", async () => {
    stubRuntime({ native: true, protocol: "tauri:", host: "localhost" });
    const { signalingUrl, NATIVE_DEFAULT_SIGNALING_URL } =
      await import("./signal.js");
    expect(signalingUrl()).toBe(NATIVE_DEFAULT_SIGNALING_URL);
    expect(NATIVE_DEFAULT_SIGNALING_URL).toBe("ws://127.0.0.1:8788/v1/ws");
  });
});

describe("deferred + withTimeout", () => {
  it("resolves and rejects through the deferred", async () => {
    const { deferred } = await import("./signal.js");
    const d = deferred<number>();
    d.resolve(42);
    await expect(d.promise).resolves.toBe(42);
    const rejected = deferred<number>();
    rejected.reject(new Error("nope"));
    await expect(rejected.promise).rejects.toThrow("nope");
  });

  it("times out slow promises", async () => {
    vi.useFakeTimers();
    const { withTimeout } = await import("./signal.js");
    const slow = new Promise<number>(() => undefined);
    const assertion = expect(withTimeout(slow, 10, "too slow")).rejects.toThrow(
      "too slow",
    );
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    vi.useRealTimers();
  });
});
