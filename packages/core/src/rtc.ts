/**
 * WebRTC glue: peer connections, trickle ICE, channel lifecycle, ICE path label.
 * Browser-only (RTC* globals); not imported by node-side packages.
 */
import type { RTCIceCandidateInitLike, SignalPayload, TurnCredential } from "./protocol.js";

export type PathLabel = "lan" | "direct" | "relay";

export interface PeerHandles {
  pc: RTCPeerConnection;
  ctrl: RTCDataChannel;
  data: RTCDataChannel;
  path(): Promise<PathLabel>;
  close(): void;
}

export interface PeerOptions {
  iceServers?: RTCIceServer[];
  sendSignal: (payload: SignalPayload) => void;
  onError?: (error: unknown) => void;
}

export interface Peer {
  readonly whenOpen: Promise<PeerHandles>;
  handleSignal(payload: SignalPayload): Promise<void>;
  close(): void;
}

export function iceServersFromTurn(turn?: TurnCredential | null): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
  if (turn && turn.uris.length > 0) {
    servers.push({ urls: turn.uris, username: turn.username, credential: turn.credential });
  }
  return servers;
}

function candidateInit(candidate: RTCIceCandidate): RTCIceCandidateInitLike {
  const init: RTCIceCandidateInitLike = { candidate: candidate.candidate };
  if (candidate.sdpMid !== null) init.sdpMid = candidate.sdpMid;
  if (candidate.sdpMLineIndex !== null) init.sdpMLineIndex = candidate.sdpMLineIndex;
  if (candidate.usernameFragment !== null) init.usernameFragment = candidate.usernameFragment;
  return init;
}

function openChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      resolve();
    };
    const onClose = (): void => {
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      reject(new Error(`channel ${channel.label} closed before opening`));
    };
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
  });
}

export function createHostPeer(options: PeerOptions): Peer {
  const pc = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
  const ctrl = pc.createDataChannel("ctrl", { ordered: true });
  const data = pc.createDataChannel("data", { ordered: true });

  const ready = Promise.all([openChannel(ctrl), openChannel(data)]).then(
    (): PeerHandles => ({
      pc,
      ctrl,
      data,
      path: () => detectPath(pc),
      close: () => pc.close(),
    }),
  );
  ready.catch((error) => options.onError?.(error));

  pc.onicecandidate = (event) => {
    if (event.candidate) options.sendSignal({ k: "candidate", candidate: candidateInit(event.candidate) });
  };
  pc.onconnectionstatechange = (): void => {
    if (pc.connectionState === "failed") options.onError?.(new Error("peer connection failed"));
  };

  const offer = (async (): Promise<void> => {
    const local = await pc.createOffer();
    await pc.setLocalDescription(local);
    if (!pc.localDescription) throw new Error("missing local description");
    options.sendSignal({ k: "offer", sdp: pc.localDescription.sdp });
  })();
  offer.catch((error) => options.onError?.(error));

  return {
    whenOpen: ready,
    async handleSignal(payload) {
      if (payload.k === "answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      } else if (payload.k === "candidate") {
        await addCandidate(pc, payload.candidate);
      }
    },
    close: () => pc.close(),
  };
}

export function createGuestPeer(options: PeerOptions): Peer {
  const pc = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
  let ctrl: RTCDataChannel | null = null;
  let data: RTCDataChannel | null = null;
  const pendingCandidates: RTCIceCandidateInitLike[] = [];

  const ready = new Promise<PeerHandles>((resolve, reject) => {
    const maybeResolve = (): void => {
      if (!ctrl || !data) return;
      Promise.all([openChannel(ctrl), openChannel(data)])
        .then(() => resolve({ pc, ctrl: ctrl!, data: data!, path: () => detectPath(pc), close: () => pc.close() }))
        .catch(reject);
    };
    pc.ondatachannel = (event) => {
      if (event.channel.label === "ctrl") ctrl = event.channel;
      if (event.channel.label === "data") data = event.channel;
      maybeResolve();
    };
    pc.onconnectionstatechange = (): void => {
      if (pc.connectionState === "failed") reject(new Error("peer connection failed"));
    };
  });
  ready.catch((error) => options.onError?.(error));

  pc.onicecandidate = (event) => {
    if (event.candidate) options.sendSignal({ k: "candidate", candidate: candidateInit(event.candidate) });
  };

  return {
    whenOpen: ready,
    async handleSignal(payload) {
      if (payload.k === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        for (const candidate of pendingCandidates.splice(0)) await addCandidate(pc, candidate);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (!pc.localDescription) throw new Error("missing local description");
        options.sendSignal({ k: "answer", sdp: pc.localDescription.sdp });
      } else if (payload.k === "candidate") {
        if (pc.remoteDescription) await addCandidate(pc, payload.candidate);
        else pendingCandidates.push(payload.candidate);
      }
    },
    close: () => pc.close(),
  };
}

async function addCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInitLike): Promise<void> {
  try {
    await pc.addIceCandidate(candidate as RTCIceCandidateInit);
  } catch {
    // Late/duplicate candidates during a reconnect are not fatal.
  }
}

/** docs/02 §6.6: map the selected candidate pair to a user-visible path label. */
export async function detectPath(pc: RTCPeerConnection): Promise<PathLabel> {
  const stats = await pc.getStats();
  const report = stats as unknown as {
    forEach(callback: (value: Record<string, unknown>) => void): void;
    get(id: string): Record<string, unknown> | undefined;
  };
  let selectedPairId: string | undefined;
  let pair: Record<string, unknown> | undefined;

  report.forEach((entry) => {
    const type = entry["type"];
    if (type === "transport" && typeof entry["selectedCandidatePairId"] === "string") {
      selectedPairId = entry["selectedCandidatePairId"] as string;
    }
    if (type === "candidate-pair" && (entry["selected"] === true || entry["nominated"] === true)) {
      pair = pair ?? entry;
    }
  });
  if (selectedPairId) {
    const fromId = report.get(selectedPairId);
    if (fromId) pair = fromId;
  }
  if (!pair) return "direct";

  const localId = pair["localCandidateId"] as string | undefined;
  const remoteId = pair["remoteCandidateId"] as string | undefined;
  const local = localId ? report.get(localId) : undefined;
  const remote = remoteId ? report.get(remoteId) : undefined;
  const localType = (local?.["candidateType"] as string | undefined) ?? "";
  const remoteType = (remote?.["candidateType"] as string | undefined) ?? "";

  if (localType === "relay" || remoteType === "relay") return "relay";
  if (localType === "host" && remoteType === "host") return "lan";
  return "direct";
}

/** HTML string for RTCIceCandidateInit transport; kept here so callers stay typed. */
export function candidatePayload(candidate: RTCIceCandidateInit | null): SignalPayload | null {
  if (!candidate) return null;
  const init: RTCIceCandidateInitLike = { candidate: candidate.candidate ?? "" };
  if (typeof candidate.sdpMid === "string") init.sdpMid = candidate.sdpMid;
  if (typeof candidate.sdpMLineIndex === "number") init.sdpMLineIndex = candidate.sdpMLineIndex;
  if (typeof candidate.usernameFragment === "string") init.usernameFragment = candidate.usernameFragment;
  return { k: "candidate", candidate: init };
}
