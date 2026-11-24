# ADR 0007 — 生产单源与静态托管

状态：已采纳（2026-11-24）

## 背景
`docs/02 §7` 要求服务器零存储、无访问日志；`ADR 0001` 决定生产由 signaling 同源服务页面与 `/v1/ws`。
M4 之前 signaling 进程只会 404，前端依赖 Vite dev server，无法单容器自托管。

## 决定
- `packages/signaling` 增加可选 `staticDir`（`src/static.ts`）：SPA 回退、`assets/*` immutable 缓存、
  `Referrer-Policy: no-referrer`、严格 CSP、`Permissions-Policy`；只读文件、无访问日志。
- 生产入口 `infra/signaling/entry.ts` 读取 `STATIC_DIR`；Dockerfile 构建阶段跑 `vite build`，
  运行时镜像含 `/app/public`，一个端口同时提供页面与信令。
- 构建期断言 `apps/web/dist/index.html` 存在，避免「镜像起来了但页面 404」。
- 反代只做 TLS/限流，转发 8788。

## 后果
- 自托管一条 `docker compose up -d` 即可用（本地已实测页面/SPA/WS/传输/零存储审计）。
- 前端会话与信令同源，SW 流式下载、CSP、wss 都无需跨源配置。
- 安全头集中在服务端，改头只需改一处；代价是 signaling 多读一个目录（只读）。
