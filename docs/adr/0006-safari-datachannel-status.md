# ADR 0006 — Safari/WebKit 数据通道现状

状态：进行中（2026-11-24 跨机实测）

## 背景
附录 A §3：Chrome 157 → Safari 27.0.1 回环数据通道 15 s 未打开、30 s 收 0 字节、`maxMessageSize` 读作 null，疑似 mDNS host candidate。

## 决定（待结论）
- 用 mac-mini 的 Safari 27 / Playwright WebKit 做跨机 100 MB 接收实测，先用局域网内 https 源。
- 若 WebKit 确实无法建立数据通道：iOS 只推原生壳，能力矩阵把 Web 接收端限制为 Chromium/ArkWeb，并更新 docs/01 §6。
- 结论落定后把本 ADR 改为「已采纳」并写清证据。

## 进展
- 2026-11-24：mac-mini 可访问 `https://room.net.time-pack.com`（跨机 200），Playwright WebKit 客户端实测脚本已发起。
