# ADR 0004 — 开发期 HTTPS 走既有反代域名

状态：已采纳（2026-11-24，实测 101/200）

## 背景
WebCrypto 需要安全上下文（附录 A §1：局域网 http 源下 `crypto.subtle` 未定义，AES-GCM 无法执行）。

## 决定
- 开发不引入 mkcert；Vite 监听 `0.0.0.0:5173` + `allowedHosts`，由既有反代暴露为 `https://room.net.time-pack.com`。
- `/v1/ws` 由 Vite 代理到 signaling（默认 `127.0.0.1:8788`，本机 8787 被无关服务占用）。
- 产品硬门禁：`caps.secureContext === false` 直接阻断并提示改用 https。

## 验证
`curl -k --http1.1 -H 'Upgrade: websocket' https://room.net.time-pack.com/v1/ws` → 101；Playwright 经该 https 源跑通 10 MB 传输。
