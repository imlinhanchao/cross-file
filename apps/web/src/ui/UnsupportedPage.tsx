import { copy } from "@crossfile/ui";
import { Icon } from "./Icon.js";

/**
 * Honest preflight (docs/01 D11 / 附录 A): WebRTC is mandatory for every transfer.
 * Some embedded webviews ship without it — notably distro WebKitGTK, which is what
 * Tauri 2 uses on Linux — so the app must say so instead of failing mid-handshake.
 */
export function UnsupportedPage() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="send" />
          </span>
          {copy.brand}
        </span>
      </header>
      <main className="shell">
        <div className="card stack gap-4" style={{ maxWidth: 640, margin: "48px auto 0" }}>
          <h1 className="h2">当前环境不支持 WebRTC</h1>
          <p className="lead">
            这个浏览器内核没有提供 RTCPeerConnection，CrossFile 无法建立点对点连接。常见于 Linux 上的
            WebKitGTK（Tauri 桌面壳默认内核）。
          </p>
          <p className="small muted">
            请改用 Chrome / Edge / Safari 打开同一地址；Windows 与 macOS 的桌面壳使用系统 WebView，通常可用。
          </p>
          <p className="note">
            <Icon name="shield-check" size="sm" />
            <span>检测到不支持时就停止，比传到一半失败更诚实。</span>
          </p>
        </div>
      </main>
    </div>
  );
}
