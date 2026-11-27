/**
 * WebRTC glue: peer connections, trickle ICE, channel lifecycle, ICE path label.
 * Browser-only (RTC* globals); not imported by node-side packages.
 */
import type {
  RTCIceCandidateInitLike,
  SignalPayload,
  TurnCredential,
} from "./protocol.js";
import { computeSas, parseDtlsFingerprint } from "./crypto.js";

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
  /** AC2 test hook: force ICE onto relay candidates (docs/02 §6.6). */
  relayOnly?: boolean;
}

export interface Peer {
  readonly whenOpen: Promise<PeerHandles>;
  handleSignal(payload: SignalPayload): Promise<void>;
  close(): void;
}

export function iceServersFromTurn(
  turn?: TurnCredential | null,
): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
  if (turn && turn.uris.length > 0) {
    servers.push({
      urls: turn.uris,
      username: turn.username,
      credential: turn.credential,
    });
  }
  return servers;
}

function candidateInit(candidate: RTCIceCandidate): RTCIceCandidateInitLike {
  const init: RTCIceCandidateInitLike = { candidate: candidate.candidate };
  if (candidate.sdpMid !== null) init.sdpMid = candidate.sdpMid;
  if (candidate.sdpMLineIndex !== null)
    init.sdpMLineIndex = candidate.sdpMLineIndex;
  if (candidate.usernameFragment !== null)
    init.usernameFragment = candidate.usernameFragment;
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

interface RtcDiagnostics {
  state(): Record<string, unknown>;
  stats(): Promise<Record<string, unknown>>;
}

function exposeDiagnostics(
  pc: RTCPeerConnection,
  /** legacy debug label: "host" = offerer, "guest" = answerer (unchanged on purpose) */
  role: "host" | "guest",
): void {
  if (typeof location === "undefined" || !location.search.includes("debug"))
    return;
  const target = globalThis as unknown as {
    __crossfileRtc?: Record<string, RtcDiagnostics>;
  };
  target.__crossfileRtc = target.__crossfileRtc ?? {};
  target.__crossfileRtc[role] = {
    state: () => ({
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      signalingState: pc.signalingState,
      iceGatheringState: pc.iceGatheringState,
      localSdp: pc.localDescription?.sdp?.slice(0, 40) ?? null,
      remoteSdp: pc.remoteDescription?.sdp?.slice(0, 40) ?? null,
    }),
    stats: async () => {
      const report = await pc.getStats();
      const out: Record<string, unknown> = {};
      report.forEach((entry) => {
        const type = entry.type;
        if (type === "candidate-pair" && (entry.selected || entry.nominated)) {
          out.pair = {
            state: entry.state,
            localCandidateId: entry.localCandidateId,
            remoteCandidateId: entry.remoteCandidateId,
            bytesSent: entry.bytesSent,
            bytesReceived: entry.bytesReceived,
          };
        }
        if (type === "local-candidate" || type === "remote-candidate") {
          const list = (out[type] as Array<Record<string, unknown>>) ?? [];
          list.push({
            id: entry.id,
            candidateType: entry.candidateType,
            address: entry.address ?? entry.ip,
            port: entry.port,
            protocol: entry.protocol,
          });
          out[type] = list;
        }
        if (type === "data-channel") {
          out.dataChannel = {
            state: entry.state,
            messagesSent: entry.messagesSent,
            messagesReceived: entry.messagesReceived,
          };
        }
        if (type === "transport") {
          out.transport = {
            dtlsState: entry.dtlsState,
            selectedCandidatePairId: entry.selectedCandidatePairId,
          };
        }
      });
      return out;
    },
  };
}

/**
 * The side that creates the data channels and offers: the pair's elected
 * offerer (ADR 0010 §reconnect).
 */
export function createOffererPeer(options: PeerOptions): Peer {
  const pc = new RTCPeerConnection({
    iceServers: options.iceServers ?? [],
    ...(options.relayOnly
      ? { iceTransportPolicy: "relay" as RTCIceTransportPolicy }
      : {}),
  });
  exposeDiagnostics(pc, "host");
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
    if (event.candidate)
      options.sendSignal({
        k: "candidate",
        candidate: candidateInit(event.candidate),
      });
  };
  pc.onconnectionstatechange = (): void => {
    if (pc.connectionState === "failed")
      options.onError?.(new Error("peer connection failed"));
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

/**
 * The side that answers an incoming offer and adopts the data channels the
 * offerer created.
 */
export function createAnswererPeer(options: PeerOptions): Peer {
  const pc = new RTCPeerConnection({
    iceServers: options.iceServers ?? [],
    ...(options.relayOnly
      ? { iceTransportPolicy: "relay" as RTCIceTransportPolicy }
      : {}),
  });
  exposeDiagnostics(pc, "guest");
  let ctrl: RTCDataChannel | null = null;
  let data: RTCDataChannel | null = null;
  const pendingCandidates: RTCIceCandidateInitLike[] = [];

  const ready = new Promise<PeerHandles>((resolve, reject) => {
    const maybeResolve = (): void => {
      if (!ctrl || !data) return;
      Promise.all([openChannel(ctrl), openChannel(data)])
        .then(() =>
          resolve({
            pc,
            ctrl: ctrl!,
            data: data!,
            path: () => detectPath(pc),
            close: () => pc.close(),
          }),
        )
        .catch(reject);
    };
    pc.ondatachannel = (event) => {
      if (event.channel.label === "ctrl") ctrl = event.channel;
      if (event.channel.label === "data") data = event.channel;
      maybeResolve();
    };
    pc.onconnectionstatechange = (): void => {
      if (pc.connectionState === "failed")
        reject(new Error("peer connection failed"));
    };
  });
  ready.catch((error) => options.onError?.(error));

  pc.onicecandidate = (event) => {
    if (event.candidate)
      options.sendSignal({
        k: "candidate",
        candidate: candidateInit(event.candidate),
      });
  };

  return {
    whenOpen: ready,
    async handleSignal(payload) {
      if (payload.k === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        for (const candidate of pendingCandidates.splice(0))
          await addCandidate(pc, candidate);
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

/** @deprecated v1 name, use {@link createOffererPeer}. */
export const createHostPeer: (options: PeerOptions) => Peer = createOffererPeer;
/** @deprecated v1 name, use {@link createAnswererPeer}. */
export const createGuestPeer: (options: PeerOptions) => Peer =
  createAnswererPeer;

async function addCandidate(
  pc: RTCPeerConnection,
  candidate: RTCIceCandidateInitLike,
): Promise<void> {
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
    if (
      type === "transport" &&
      typeof entry["selectedCandidatePairId"] === "string"
    ) {
      selectedPairId = entry["selectedCandidatePairId"] as string;
    }
    if (
      type === "candidate-pair" &&
      (entry["selected"] === true || entry["nominated"] === true)
    ) {
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

/**
 * 6-digit-code path SAS (docs/02 §3.5/§4.5): derive the 4 emoji from both DTLS
 * fingerprints. Returns null until the peer connection has both descriptions.
 */
export function sasFromPeerConnection(pc: RTCPeerConnection): string[] | null {
  const localSdp = pc.localDescription?.sdp;
  const remoteSdp = pc.remoteDescription?.sdp;
  if (!localSdp || !remoteSdp) return null;
  const local = parseDtlsFingerprint(localSdp);
  const remote = parseDtlsFingerprint(remoteSdp);
  if (!local || !remote) return null;
  return computeSas(local, remote);
}

/** HTML string for RTCIceCandidateInit transport; kept here so callers stay typed. */
export function candidatePayload(
  candidate: RTCIceCandidateInit | null,
): SignalPayload | null {
  if (!candidate) return null;
  const init: RTCIceCandidateInitLike = {
    candidate: candidate.candidate ?? "",
  };
  if (typeof candidate.sdpMid === "string") init.sdpMid = candidate.sdpMid;
  if (typeof candidate.sdpMLineIndex === "number")
    init.sdpMLineIndex = candidate.sdpMLineIndex;
  if (typeof candidate.usernameFragment === "string")
    init.usernameFragment = candidate.usernameFragment;
  return { k: "candidate", candidate: init };
}
