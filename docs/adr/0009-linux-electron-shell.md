# ADR 0009 — Linux 桌面壳改用 Electron（Chromium）

状态：已采纳（2026-11-24）

## 背景
ADR 0008：Ubuntu 的 WebKitGTK（Tauri 2 在 Linux 的内核）没有 `RTCPeerConnection`，Linux Tauri 壳无法传输。
AC9 要求桌面壳内跑通 500 MB，需要在 Linux 上有一个带 WebRTC 的桌面容器。

## 决定
- 新增 `apps/desktop-electron/`：Electron 壳，仅用于 Linux（Windows/macOS 仍用 Tauri，系统 WebView 支持 WebRTC）。
- **前端零改动**：preload 暴露与 Tauri 相同的 `window.__TAURI__` 桥（`core.invoke` / `event.listen`）与
  `__CROSSFILE_NATIVE__`，Web 的 native sink、关窗确认、菜单事件全部复用。
- IPC 命令与 `docs/desktop.md §4` 完全一致：`save_open/save_write(offset)/save_close/save_abort`、
  `set_transfer_active`、`confirm_close`；保存目录 `app.getPath("downloads")`，文件名清洗 + 同名去重。
- 菜单「房间/编辑/帮助」与服务端隔离；关窗时若传输中则阻止并通知前端确认。

## 验证（2026-11-24，Linux）
- 100 MB：Electron 作为接收方（native 写盘），host 端 `HASH MATCHES EXPECTED: true`；
  落盘文件 sha256 与发送方一致；
- **500 MB**：路径「局域网直连（lan）」，host `sha256=ccd606e7…`，落盘文件 524 288 000 B、
  sha256 完全相同。
- 复现：`CROSSFILE_URL=<房间链接> HOME=<可写目录> electron apps/desktop-electron --no-sandbox`。
- 打包：`electron-builder --linux AppImage` 产出 `CrossFile-0.1.0-x86_64.AppImage`（约 120 MB），
  `--appimage-extract` 验证包含 `app.asar` 与启动器；**解包后的 AppImage 作为接收端实跑 100 MB 通过**
  （落盘 sha256 与发送方一致）。运行需 FUSE，图标待补（默认 Electron 图标）。

## 后果
- Linux 桌面从「不可用」变为「可用」，代价是多一套壳依赖（Electron ≈230 MB 解压体积）；
- 发布物需要分别打包：Tauri（Win/macOS）+ Electron（Linux），CI/文档分别说明；
- Windows/macOS 的 Tauri 壳仍未实机验证（WebView2/WKWebView 支持 WebRTC，风险低）。
