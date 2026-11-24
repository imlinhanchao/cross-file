# ADR 0006 — Safari/WebKit 数据通道现状

状态：已结案（2026-11-24）

## 背景
附录 A §3：Chrome 157 → Safari 27.0.1 回环数据通道 15 s 未打开、30 s 收 0 字节、`maxMessageSize` 读作 null，疑似 mDNS host candidate。

## 决定（待结论）
- 用 mac-mini 的 Safari 27 / Playwright WebKit 做跨机 100 MB 接收实测，先用局域网内 https 源。
- 若 WebKit 确实无法建立数据通道：iOS 只推原生壳，能力矩阵把 Web 接收端限制为 Chromium/ArkWeb，并更新 docs/01 §6。
- 结论落定后把本 ADR 改为「已采纳」并写清证据。

## 进展
- 2026-11-24：mac-mini 可访问 `https://room.net.time-pack.com`（跨机 200），Playwright WebKit 客户端实测发起。
- 2026-11-24：跨机 WebKit 27.2 实测——信令 join/approve 正常，但 ICE 直连 `checking → failed`（~30 s，`dtlsState=new`，无选中候选对）；WebKit 收集到 host/srflx，host（Chrome）端未收到 remote candidate。
- 2026-11-24：强制 TURN（coturn `turn:192.168.50.200:3478`，Chrome 端 relay 候选正常）时 WebKit 端 `iceGatheringState=complete` 但**零 local candidate**；TURN TCP 可达、UDP 未确认。待排除 WebKit 的 TURN/UDP 与 STUN 配置后结论。
- 2026-11-24（隔离实验）：mac-mini 上 Node UDP STUN 到 coturn 正常；同一台机器的 Playwright WebKit 对 `stun:` 能拿到 srflx，但对 `turn:`（udp/tcp、relay 策略）12 s 内零 relay 候选、gathering 不完成、无 `icecandidateerror`；coturn verbose 日志无来自该机的 Allocate。真 Safari 因 macOS TCC 自动化权限未验。
- 2026-11-24（结案）：真 Safari 27.0.1 接收 100 MB 成功（TURN 中继，双方 SHA-256 一致，约 74 Mbps）。此前 Playwright WebKit 的失败被证明是**测试载具假阴性**：Playwright WebKit 不向局域网发 UDP（自建 UDP 监听器零收包），而同一台机器的真实 Safari 与 Node 都能正常收发。
- 结论：Safari/WebKit 的 WebRTC 数据通道可用；产品侧仍应把 TURN 视为 Safari/iOS 的可靠路径（D2 已定），直连候选在跨机/权限受限环境下不可依赖。
- 能力矩阵暂不提高 Safari/iOS 上限：Safari 内的保存点击与 iOS 仍未验证；保存路径通过后再放宽（docs/01 §6 注释）。
