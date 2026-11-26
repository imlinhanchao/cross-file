import { EntryPage } from "./pages/EntryPage.js";
import { RoomPage } from "./pages/RoomPage.js";
import { PrivacyPage } from "./pages/PrivacyPage.js";
import { UnsupportedPage } from "./ui/UnsupportedPage.js";
import type { RoomMode } from "./lib/room.js";

function hasWebRTC(): boolean {
  const globals = globalThis as { RTCPeerConnection?: unknown };
  return typeof globals.RTCPeerConnection === "function";
}

export function App() {
  if (!hasWebRTC()) return <UnsupportedPage />;
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  // Debug shells pass the room key as a query parameter (native IPC origin,
  // docs/05 §7.0.13); the controller only honours it for shell debug builds.
  if (params.has("devkey")) return <RoomPage mode={{ kind: "auto" }} />;
  if (path.startsWith("/r/") || path.startsWith("/j/"))
    return <RoomPage mode={{ kind: "auto" }} />;
  if (path.startsWith("/room")) return <RoomPage mode={{ kind: "create" }} />;
  if (path.startsWith("/code")) return <EntryPage focusCode />;
  if (path.startsWith("/privacy")) return <PrivacyPage />;
  return <EntryPage />;
}

export type { RoomMode };
