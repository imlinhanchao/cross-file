# 验收记录（docs/01 §8 AC1–AC9 + 计划 §1 U1–U8）

> 最近更新：2026-11-24。每行都注明**实际跑过的命令与结果**；未验证项明确写「待验」，不放宽标准。

## 环境

| 角色 | 机器 | 说明 |
|---|---|---|
| 发送方 / 服务端 | Linux（hancel-service） | Node 22.22.1、Chrome 157.0.8103.38、Docker 29.4、16C/28G |
| 接收方 | mac-mini | macOS 27.0.1、Safari 27.0.1、iOS 27.2 模拟器、Xcode 27.2 |
| 开发入口 | `https://room.net.time-pack.com` | 既有反代 → Vite :5173 → `/v1/ws` → signaling :8788 |
| TURN | 本机 coturn（Docker） | `turn:192.168.50.200:3478`，`infra/docker-compose.yml` 桥接 + `TURN_EXTERNAL_IP` |

## 结果矩阵

| # | 场景 | 状态 | 证据 |
|---|---|---|---|
| AC1 | Chrome↔Chrome 同网 500 MB ≥60 Mbps，显示「局域网直连」 | ✅ 本机 + 跨机 Chromium | 本机：500 MB 28 s ≈150 Mbps，路径「局域网直连」；**跨机 Chrome→Edge(Chromium, mac-mini) 500 MB 63 s ≈66.6 Mbps，路径「直连」，双方 SHA-256 `2d58573f…` 一致**。注：跨机跑出的是 srflx 直连（路径「直连」），未观察到 host↔host 的「局域网直连」标签（Chromium mDNS 候选跨解析限制），属 D2 阶梯内的第二档 |
| AC2 | 仅 TURN 500 MB，显示「中继」 | ✅ 本机（含限速 10 Mbps） | coturn + `?relay=1`：10/100/500 MB 均 PASS，路径「中继」，哈希一致；**限速验证**：coturn `--max-bps=1250000`（≈10 Mbps），500 MB 用时 **451.8 s（7.5 min < 10 min）**，有效速率 ≈9.3 Mbps，双方 SHA-256 `85d76e70…` 一致。`E2E_RELAY=1 … pnpm exec playwright test tests/e2e/ac2-relay.spec.ts` |
| AC3 | 传输中断 60 s 内重连续传，只重传缺失分片，哈希一致 | ✅ | `tests/e2e/ac3-resume.spec.ts`：20 MB，50% 强断 → 重连 → 只补 295 片 → 哈希一致 |
| AC4 | Chrome→iPhone Safari 100 MB；500 MB 分级提示 | 🟡 传输侧通过（桌面 100/500 MB + iOS 模拟器 100 MB）/ 保存与 iOS 落盘待人工 | 桌面 Safari 100 MB（中继）与 500 MB（直连）、iOS 27.2 模拟器 Safari 100 MB（中继）均双方哈希一致；接收端超软上限风险对话框由 `capability-warn.spec.ts` 覆盖；Safari「保存」点击需用户手势，未自动化 |
| AC5 | 6 位码加入 + 4 emoji SAS，不一致中止 | ✅ | `tests/e2e/code-sas.spec.ts`：6 位码加入 → 双方 SAS 一致 → ctrl 通道下发 roomKey → 2 MB 哈希一致 |
| AC6 | 2 接收方顺序、文件×人矩阵、不并发 | ✅ | `tests/e2e/ac6-multi.spec.ts`：矩阵默认全员、guest1 完成前 guest2 不开始、两人哈希一致 |
| AC7 | 房间结束即销毁；强杀 ≤30 min 清理 | ✅ | `tests/e2e/ac7-room-close.spec.ts`：guest 立即收 room_closed、内存房间删除、迟到 join 被拒 |
| AC8 | 零存储审计 | ✅ | `bash tests/audit/zero-storage.sh` → RESULT PASS（strace：0 写文件、0 DB、stdout 仅 1 行）；`SKIP_BUILD=1 … --container` → PASS（只读/非 root/无 mount/EROFS/down -v 干净） |
| AC9 | 桌面/手机壳各跑 500 MB | 🟡 壳与原生写盘已验证；**Linux 桌面壳无法做 WebRTC**（见 ADR 0008）/ 手机缺真机 | 桌面：`cargo check/test`、deb 2.49 MiB、IPC 端到端比特级正确；实测 Tauri 2 在 Ubuntu 的 WebKitGTK **没有 `RTCPeerConnection`**，所以 Linux 桌面壳不能传输——Web 端已加诚实预检（e2e 固化），文档建议 Linux 用 Chrome/Edge/Safari；Windows/macOS 壳待真机验证。手机：Android target 构建 + APK 116 MB 产出，运行需真机或 KVM |

## U1–U8

| # | 判据 | 状态 |
|---|---|---|
| U1 | compose + dev 可起，HTTPS 入口可用 | ✅ 三条链路实测：dev 域名；compose `up/ps/logs/down -v`；**生产单源容器**（Dockerfile 构建阶段跑 vite、运行时 `STATIC_DIR=/app/public`，`docker compose up` 后 `http://127.0.0.1:18788` 返回页面+安全头、SPA 路由 200、Playwright 双上下文 10 MB 哈希一致，容器零存储审计仍 PASS） |
| U2 | 双端 100 MB 哈希一致 | ✅ 本机 Chromium↔Chromium 9.1 s；跨机 Chrome→Safari 直连/中继均一致 |
| U3 | 500 MB 走通 + 真实路径标签 | ✅ 本机「局域网直连」150 Mbps；跨机「直连」153 Mbps；仅中继 500 MB PASS |
| U4 | 断流续传 | ✅ AC3 |
| U5 | 6 位码 + SAS；结束房间即销毁 | ✅ AC5 + AC7 |
| U6 | 零存储审计 | ✅ AC8 |
| U7 | 门禁全绿 | ✅ typecheck / 95 单测 / 对比度 25/25 / 零硬编码色值 / 7 个 e2e（AC2 按 `E2E_RELAY=1` 单独跑） |
| U8 | 文档齐 | ✅ README/自托管/隐私页/LICENSE/ADR/desktop/mobile/验收记录/**官方实例部署清单**齐备；公网实例本身待按清单执行（需要你的域名与公网 IP） |

## 复现命令

```bash
pnpm install
pnpm dev                                   # signaling :8788 + web :5173
pnpm gate                                  # typecheck + 单测 + 对比度 + 零硬编码色值
pnpm e2e                                   # 默认 e2e（AC2 用例自动跳过）
docker compose -f infra/docker-compose.yml up -d --build
bash tests/audit/zero-storage.sh
SKIP_BUILD=1 bash tests/audit/zero-storage.sh --container
E2E_RELAY=1 TURN_SECRET=… TURN_URIS='turn:<host>:3478?transport=udp' pnpm exec playwright test tests/e2e/ac2-relay.spec.ts

# AC2 限速验证（≈10 Mbps 下 500 MB < 10 分钟）
docker run -d --name cf-coturn-10mbps -p 3478:3478 -p 3478:3478/udp -p 49160-49200:49160-49200/udp \
  coturn/coturn:4.19.2-alpine --listening-port=3478 --static-auth-secret=$TURN_SECRET --realm=crossfile \
  --external-ip=<public-ip> --min-port=49160 --max-port=49200 --max-bps=1250000 --log-file=stdout
DEBUG_RELAY=1 DEBUG_MAX_SECONDS=900 node scripts/debug-transfer.mjs 500
TURN_SECRET=… AC4_QUERY='debug=1&relay=1&autoaccept=1&report=https%3A%2F%2Froom.net.time-pack.com%2F__report' \
  node scripts/ac4-host-loop.mjs 100      # 跨机：在另一台设备用 Safari 打开发布的链接
```

> `?autoaccept=1` 与 `?report=` 只在 `import.meta.env.DEV`（dev server）生效，生产构建已确认剥离；`/__report` 端点只在 `vite serve` 注册。
