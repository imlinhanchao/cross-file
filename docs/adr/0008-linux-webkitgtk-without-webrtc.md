# ADR 0008 — Linux 桌面壳：发行版 WebKitGTK 不含 WebRTC

状态：已确认（2026-11-24），v1 按限制发布

## 事实
在 Ubuntu 24.04（webkit2gtk-4.1 2.52.6）上，Tauri 2 的 WebKitGTK webview 里
`typeof RTCPeerConnection === "undefined"`。桌面壳页面能加载、IPC/原生写盘都能用，
但一进入建连就抛 `ReferenceError: Can't find variable: RTCPeerConnection`（已用
debug-only 诊断通道从 webview 内取证）。

根因：发行版 WebKitGTK 构建默认关闭 WebRTC（`ENABLE_WEB_RTC=OFF`，上游 libwebrtc
打包成本高）。这不是我们的代码问题，Windows WebView2 / macOS WKWebView 不受影响（未实测）。

## 决定（v1）
1. **诚实预检**：Web 端在启动时检测 `RTCPeerConnection`，缺失则直接显示「当前环境不支持 WebRTC」
   并给出替代方案，不创建房间、不发起失败握手（`apps/web/src/ui/UnsupportedPage.tsx` + e2e）。
2. **Linux 桌面壳定位为「浏览器外壳」**：文档写明 Linux 用户请用 Chrome/Edge/Safari 打开
   `http://<host>:8788`（自托管单源已支持），或使用 Windows/macOS 壳。
3. 不为此改动 Tauri/WebKit 构建链（自行编译 libwebrtc 体积与维护成本过高）。

## 后续可选项（v2 再评估）
- 在 Linux 上用 Electron/CEF（自带 Chromium，含 WebRTC）替代 WebKitGTK 壳；
- 或打包启用 WebRTC 的 WebKitGTK（Flatpak/Snap 或自建），并承担体积与更新成本；
- 或桌面壳在 Linux 上退化为「启动本地 single-origin 服务 + 打开系统默认浏览器」。

## 证据
- `docs/05 §7.0.8` 的 Tauri 运行记录；`tests/e2e/webrtc-missing.spec.ts` 固化预检行为；
- 桌面壳 `save_*` IPC 仍然有效（无 WebRTC 时用户不会被引导进入传输）。
