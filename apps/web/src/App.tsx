import { HostPage } from "./pages/HostPage.js";
import { GuestPage } from "./pages/GuestPage.js";
import { CodePage } from "./pages/CodePage.js";
import { PrivacyPage } from "./pages/PrivacyPage.js";
import { UnsupportedPage } from "./ui/UnsupportedPage.js";

function hasWebRTC(): boolean {
  const globals = globalThis as { RTCPeerConnection?: unknown };
  return typeof globals.RTCPeerConnection === "function";
}

export function App() {
  if (!hasWebRTC()) return <UnsupportedPage />;
  // Debug shells open the guest page on their own origin with the room key in a
  // query parameter (native IPC is only allowed there); the controller validates
  // the debug shell flag before honouring it.
  if (new URLSearchParams(location.search).has("devkey")) return <GuestPage />;
  if (location.pathname.startsWith("/r/")) return <GuestPage />;
  if (location.pathname.startsWith("/j/")) {
    const code = location.pathname.split("/")[2] ?? "";
    return <GuestPage code={code} />;
  }
  if (location.pathname.startsWith("/code")) return <CodePage />;
  if (location.pathname.startsWith("/privacy")) return <PrivacyPage />;
  return <HostPage />;
}
