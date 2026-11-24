# Fact sheet — cross-platform 500 MB file sharing (facts only)

Rig: Ubuntu 24.04, Chrome 157.0.8103.38 headless; insecure origin `http://192.168.50.200:8099` vs `http://localhost:8099`; Safari 27.0.1/macOS driven through a LAN peer.

## 1. Insecure origin (`http://` on a LAN IP)

- **Chrome 157:** `isSecureContext:false`; `crypto.subtle`, `serviceWorker`, `storage.getDirectory`, all three FSA pickers, Web Bluetooth/USB/HID, `share`, `wakeLock` all **undefined**; digest → TypeError. Available: `RTCPeerConnection` (loopback data channel delivered a real message), `WebSocket` (real `ws://`), `getRandomValues`. **high**, own probe.
- **Safari 27.0.1, same URL:** identical pattern; `RTCPeerConnection`/`WebSocket` are `function`. **high** (probe); §3 for the channel itself.
- WebCrypto: `[SecureContext] interface SubtleCrypto` and `[SecureContext] readonly attribute SubtleCrypto subtle`, but `getRandomValues` is not gated — matches both probes. https://w3c.github.io/webcrypto/ **high**
- Service Workers: “must execute in secure contexts” (§6.1). https://w3c.github.io/ServiceWorker/ **high**
- WebRTC: `[Exposed=Window] interface RTCPeerConnection`, zero `[SecureContext]` in the spec; MDN’s RTCPeerConnection page has no secure-context banner (the FSA and Service Worker pages do). https://www.w3.org/TR/webrtc/ **high**
- WebSocket: not gated; only `https://` pages are forced to `wss://`. https://developer.mozilla.org/en-US/docs/Web/API/WebSocket **high**
- localhost exemption: `http://localhost` ✅ Secure vs `http://example.com` ❌. https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts **high**

## 2. FSA & streaming to disk

- Pickers are `[SecureContext] partial interface Window`. https://wicg.github.io/file-system-access/ **high**
- caniuse `native-filesystem-api`: Chrome/Edge ✅, Firefox ❌, Safari ❌, **Chrome Android ❌**, iOS ❌ ⇒ desktop Chromium only. https://caniuse.com/native-filesystem-api **high**
- Without FSA: service-worker streaming (needs a SW ⇒ secure origin, none on iOS), Blob URL (memory-buffered), or native file I/O. OPFS is origin-private, also secure-only. **high**
- Chrome on localhost: `storage.estimate()` quota = 10 737 418 240 B (10 GiB); threw on the insecure origin.
- iOS Safari: no FSA; downloads go via WebKit’s download manager into Files › Downloads — **unverified** (Apple pages returned 429); memory ceiling and lock-screen behaviour **unverified**.

## 3. Data channels in practice

- `sctp.maxMessageSize` = **262 144 B (256 KiB)**; 1 MiB and 4 MiB `send()` threw `TypeError: … larger than max-message-size`. Spec default 65 536 B without SDP max-message-size; TypeError mandated above it. https://www.w3.org/TR/webrtc/ **high**
- Flow control is `bufferedAmount` + `bufferedAmountLowThreshold` + `onbufferedamountlow` only. **high**
- Measured loopback goodput, 8 MB high-water mark: 32 MiB in 1668 ms = **161 Mbit/s** @256 KiB; 16 MiB in 1206 ms = **111 Mbit/s** @64 KiB; TTFB 20–35 ms. Not LAN or relay. **high** for the figure; real LAN/TURN rates **unverified**.
- **Safari:** the loopback channel never opened within 15 s, and the 8 MB send test received 0 B in 30 s, while `sctp.maxMessageSize` read `null`. Cause unknown (mDNS host candidates suspected); needs a repeat run. **low**
- Safari’s max message size and bufferedAmount behaviour: **unverified**.

## 4. TURN cost and visibility

- Cloudflare Realtime TURN: **$0.05/real-time GB** outbound, free with their SFU. https://developers.cloudflare.com/calls/turn/ **high**
- Metered: 150 GB/$99 ($0.40/GB overage), 500 GB/$199 ($0.20/GB), $0.04–0.10/GB at volume; billed **ingress + egress** ⇒ a relayed byte is paid for twice. https://www.metered.ca/pricing **high**
- TURN sees ciphertext only: data channels are DTLS(-SCTP) end-to-end, the relay forwards opaque packets; RFC 8656 supplies hop security only and says apps wanting end-to-end security must encrypt — WebRTC already does. https://www.rfc-editor.org/rfc/rfc8656.html **high**
- Self-hosted coturn (https://github.com/coturn/coturn): no authoritative throughput or $/GB benchmark found → **unverified**; bounded by VPS bandwidth and per-flow CPU.

## 5. LAN discovery

- No page-level discovery: no mDNS/multicast API, and host ICE candidates are obfuscated as random mDNS `.local` names. https://datatracker.ietf.org/doc/draft-ietf-mmusic-mdns-ice-candidates/ **high**
- Web Bluetooth/USB/HID/Serial: secure-context-only plus a per-device gesture (undefined on the http LAN origin).
- Native-only: Bonjour browsing, BLE advertising, Wi-Fi Direct/multicast; iOS 14+ requires user consent for any app browsing the local network. https://support.apple.com/en-us/102229 **high**
- Permission-free web route: out-of-band QR/short-code pairing, then WebRTC.
## 6. Tauri 2

- 2.0 stable 2 Oct 2024: desktop macOS/Linux/Windows **and** iOS/Android. https://v2.tauri.app/blog/tauri-20/ **high**
- “Size … can be as small as 600 KB” (OS webview) — a floor, not a typical app. https://tauri.app/ **medium**
- Official `tauri-plugin-localhost` serves assets over `http://localhost:<port>` and warns of “considerable security risks”; arbitrary HTTP/WS servers are plain Rust in-process (axum, tokio-tungstenite); no first-party WebSocket-server plugin found. https://github.com/tauri-apps/tauri-plugin-localhost **medium**
- App Store / Play shipping documented; review specifics **unverified**. https://v2.tauri.app/distribute/
- iOS LAN rule applies to the app: `NSLocalNetworkUsageDescription` (+ `NSBonjourServices`).

## 7. iOS PWA

- No FSA ⇒ share sheet / `<a download>` only.
- No Background Sync. https://caniuse.com/background-sync **high**
- Web Share Target: WICG spec, Chromium-only, no Safari support found. https://wicg.github.io/web-share-target/ **medium**
- All script-writable storage (IndexedDB, localStorage, SW caches) wiped after 7 days without interaction; home-screen web apps keep their own counter. https://webkit.org/blog/10218/ **high**
- 500 MB surviving screen lock: **unverified** — no source; both platforms suspend page timers when locked.

## 8. Chrome Local Network Access

- Chrome 142 ships the prompt (post updated 2025-09-29): gates public→local/loopback, secure contexts only, mixed content exempt for private-IP literals, `.local`, or `targetAddressSpace:"local"`. https://developer.chrome.com/blog/local-network-access **high**
- Per that post, WebSockets/WebTransport/WebRTC are **not yet gated** (crbug 421223919). https://wicg.github.io/local-network-access/ **high** for the post; may be stale.
- Chrome 157 probe: permission reads `prompt` on `http://localhost`, `denied` on the http LAN origin; a localhost page fetching/WebSocket-ing the LAN IP worked unprompted. Public→LAN **not reproduced** offline.

**Not verified:** Firefox column (its snap build fails here with a DBus error); real LAN and TURN throughput; coturn economics; iOS download memory/lock-screen; App Store review specifics; whether WebRTC got gated after Chrome 142.
