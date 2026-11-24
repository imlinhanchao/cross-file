# ADR 0001 — TypeScript 单一世界 + 单源部署

状态：已采纳（2026-11-24）

## 背景
需要一套代码覆盖 Web / 桌面壳 / 手机壳，同时满足「零安装接收端」与「服务器零存储」。

## 决定
- TypeScript 全栈：`packages/core`（协议/加密/传输，无 DOM 依赖）+ `packages/signaling`（Node 22 + ws）+ `packages/ui` + `apps/web`（React 19 + Vite 7）+ `apps/desktop` / `apps/mobile`（Tauri 2）。
- 生产由 signaling 单进程同时服务静态站点与 `/v1/ws`（同源）。开发期 Vite `5173` 经反代暴露为 `https://room.net.time-pack.com`，`/v1/ws` 由 Vite 代理到 `127.0.0.1:8788`。
- 状态管理 Zustand；单测 Vitest；e2e Playwright（系统 Chrome + WebKit）。

## 后果
- SW 流式下载、CSP、wss 都不需要跨源处理。
- 换栈成本集中在 core 的协议边界，其余是壳。
