/**
 * Small deterministic doubles for the web-layer unit tests (send/receive/peer).
 * They do not emulate WebRTC: only the handful of members the state machines
 * touch, with recorded sends and a `waitFor` polling helper.
 */
import type { Caps, PathLabel, PeerHandles } from "@crossfile/core";

export interface FakeHandles {
  handles: PeerHandles;
  ctrlSent: string[];
  dataSent: Uint8Array[];
}

export function fakeHandles(
  options: { maxMessageSize?: number } = {},
): FakeHandles {
  const ctrlSent: string[] = [];
  const dataSent: Uint8Array[] = [];
  const ctrl = {
    readyState: "open" as RTCDataChannelState,
    send: (payload: string): void => {
      ctrlSent.push(payload);
    },
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  };
  const data = {
    readyState: "open" as RTCDataChannelState,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: (frame: Uint8Array): void => {
      dataSent.push(frame);
    },
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  };
  const pc = {
    sctp: { maxMessageSize: options.maxMessageSize ?? 262_144 },
  };
  const handles = {
    pc,
    ctrl,
    data,
    path: async (): Promise<PathLabel> => "lan",
    close: (): void => undefined,
  } as unknown as PeerHandles;
  return { handles, ctrlSent, dataSent };
}

export const fakeCaps: Caps = {
  platform: "linux",
  uaFamily: "chrome",
  nativeShell: false,
  secureContext: true,
  fsAccess: false,
  sw: false,
  swDownload: false,
  saveStrategies: ["blob"],
  screen: "desktop",
};

export function ctrlTypes(ctrlSent: string[]): string[] {
  return ctrlSent.map((raw) => (JSON.parse(raw) as { type: string }).type);
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error("promise timeout")), timeoutMs),
    ),
  ]);
}
