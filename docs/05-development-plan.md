# CrossFile 开发计划（执行版）

> 本文件是开发期间**唯一活文档**：计划 + 实际进度 + 偏差记录。
> 上游事实源：`01-design.md`（决策 D1–D18、验收 AC1–AC9）、`02-protocol.md`、`03-roadmap.md`、`04-design-system.md`、附录 A/B/C。
> 目标：达到 §1 的 U1–U8「开发完成并可用」。

## 1. 完成定义（DoD）

| # | 判据 | 状态 |
|---|---|---|
| U1 | `docker compose -f infra/docker-compose.yml up -d` + `pnpm dev` 可起，`https://room.net.time-pack.com` 可访问 | 进行中（infra-dev） |
| U2 | 双端 100 MB 传完且 SHA-256 一致（主判据） | ✅ 本机双上下文 9.1 s，哈希一致 |
| U3 | 500 MB 走通，UI 显示真实路径标签 | ⚠️ 本机 500 MB 28 s、路径「局域网直连」（尚需跨机/TURN 验证） |
| U4 | 断流续传（50% 断开、60 s 内重连、只补缺片、哈希一致） | ☐ |
| U5 | 6 位码 + 4 emoji SAS；结束房间即销毁 | ☐（服务端短码已实现，客户端输码页与 SAS 未接） |
| U6 | 零存储审计（无 DB / 无写盘 / 无访问日志） | 进行中（infra-dev：strace 审计脚本） |
| U7 | 门禁全绿（typecheck / 单测 core ≥80% / 对比度 24/24 / 零硬编码色值 / e2e） | ⚠️ typecheck/82 单测/对比度/色值/e2e 全绿；覆盖率阈值待接线 |
| U8 | 文档齐（README 可照做、自托管、隐私页、LICENSE） | ☐ |

## 2. 已采纳决策（不再逐项确认）

| 项 | 值 | 说明 |
|---|---|---|
| 技术栈 | TS + React 19 + Vite 7 + Node 22/ws + Tauri 2 + coturn + MIT | `01` §10 推荐值 |
| 产品名 | CrossFile（代号），包前缀 `@crossfile/` | 品牌名延后 |
| 样式 | 不引 Tailwind；`design/tokens/tokens.css` + 迁移后的 `base.css` | 避免双体系、满足"零硬编码色值"门禁 |
| UI 语言 | 仅中文，文案集中 `packages/ui/src/copy.ts` | 留 i18n 口 |
| 部署 | 生产单源：signaling 同时服务静态页与 `/v1/ws` | SW 流式下载/CSP 免跨源 |
| 开发 origin | `https://room.net.time-pack.com` → 127.0.0.1:5173（既有反代，`allowedHosts`） | WebCrypto 需安全上下文 |
| 移动验证 | 本机 Android AVD + mac-mini iOS 27.2 模拟器 | 无实体 iPhone |
| 协作 | Agent Teams，写域按包切分 | 见 §6 |

## 3. 里程碑与门禁

| 里程碑 | 交付 | 门禁 | 状态 |
|---|---|---|---|
| **M0 骨架联调** | monorepo / CI / dev-env；signaling 最小版；core 最小版（roomId/roomKey/QR/PC/双通道）；web 建房页 + 加入页 | 两标签页 10 MB 哈希一致 | ☐ |
| **M1 协议核心** | crypto（HKDF/AES-GCM/SAS/增量 SHA-256）、帧编解码、manifest、流控、续传 bitmap、能力包与阈值、错误码、本地 coturn、路径标签 | AC1 AC2 AC3 AC7 AC8 | ☐ |
| **M2 壳与保存层** | Tauri 2 桌面壳、手机壳（Android AVD + iOS 模拟器）、sink `native/fs/sw/blob`、Safari 自研 SW 流式下载、阈值校准 | AC4 AC9 | ☐ |
| **M3 产品化** | 多接收方队列 + 文件×人矩阵、审批/移除/结束、6 位码 + SAS emoji、全状态与无障碍 | AC5 AC6 | ☐ |
| **M4 发布可用** | docker-compose 一键自托管、官方实例、隐私页、自托管文档、LICENSE | U1–U8 复跑 | ☐ |
| **M5 发布后** | 鸿蒙 API 26 冒烟、真机待办、v1.x backlog | 报告归档 | ☐ |

## 4. 工作包（WBS）

| WS | 内容 | 人日 | 状态 |
|---|---|---|---|
| WS0 | 仓库/工具链/CI/dev-env/Playwright/Tauri CLI | 1.0 | ☐ |
| WS1 | `packages/signaling`：房间状态机、消息表、短码、TTL、限流、TURN 凭据、零存储 | 3.0 | ☐ |
| WS2 | `core/crypto`：HKDF、AES-256-GCM 分片、SAS、joinProof、增量 SHA-256 | 1.5 | ☐ |
| WS3 | `core/protocol`：消息 schema、帧编解码、manifest、错误码、状态机 | 1.5 | ☐ |
| WS4 | `core/transfer`：分片器、流控、队列、续传 bitmap、进度、哈希校验 | 3.0 | ☐ |
| WS5 | `core/rtc`：PeerConnection、trickle、路径识别、重连 | 1.5 | ☐ |
| WS6 | `core/capability`：detectCaps、六级阈值、judgeFile | 1.0 | ☐ |
| WS7 | `core/sink`：blob / fs / sw / native | 3.0 | ☐ |
| WS8 | `packages/ui` + `apps/web`：设计系统迁移、页面、状态、无障碍 | 5.0 | ☐ |
| WS9 | `apps/desktop`：Tauri 2 桌面壳 | 2.0 | ☐ |
| WS10 | `apps/mobile`：Tauri 2 iOS/Android | 3.0 | ☐ |
| WS11 | 鸿蒙 ArkWeb 冒烟 | 0.5 | ☐ |
| WS12 | e2e/perf/审计 | 4.0 | ☐ |
| WS13 | infra/deploy/文档 | 2.5 | ☐ |

## 5. 环境事实（实测）

- Node 22.22.1 / pnpm 12.6.0 / Rust 1.90.0 / Docker 29.4.1 + Compose v5.1.3 / Chrome 157.0.8103.38
- WebKitGTK dev 2.52.6 已装（`pkg-config webkit2gtk-4.1` OK）→ Linux 桌面壳可编译
- JDK 21.0.13.1、Android SDK 完整（build-tools 35/36、platforms 33–37、NDK 28.2.13676358、AVD `Medium_Phone_API_37.0`）；`scripts/dev-env.sh` 负责导出，不改 shell rc
- 鸿蒙 CLT 26.0.0.821 + API 26 模拟器
- mac-mini：macOS 27.0.1 / Safari 27.0.1 / Xcode 27.2 / iOS 27.2 模拟器（iPhone 17）
- Tauri CLI：cargo 安装因 crates.io 抖动失败 → 改用 npm 版 `@tauri-apps/cli`（2.12.6）

## 6. 协作与写域

| 角色 | 写域 | 工作包 |
|---|---|---|
| Lead | 根配置、`scripts/`、CI、`packages/core`（crypto/protocol/transfer/rtc）、集成与发布 | 编排 + 核心 |
| signaling | `packages/signaling/**`、`tests/integration/**` | WS1 |
| web-ui | `apps/web/src/ui/**`、`packages/ui/**` | WS8 表现层 |
| qa | `tests/e2e/**`、`tests/perf/**` | WS12 |
| shells | `apps/desktop/**`、`apps/mobile/**` | WS9/WS10 |

规则：根配置只由 Lead 改；跨包接口先改契约再改实现；写域不重叠；合并后 Lead 跑全量。

## 7. 变更与偏差记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-24 | 开发 origin 用既有反代域名替代 mkcert | 本机已有 HTTPS 入口 |
| 2026-11-24 | Tauri CLI 用 npm 版 | `cargo install tauri-cli` 因 crates.io 超时失败 |
| 2026-11-24 | 不引 Tailwind | 设计系统已是纯 CSS token 体系 |
| 2026-11-24 | ctrl 消息统一 `{v:1,type}` 判别字段；`created` 增加 `code`；`join_ok.turn` 可缺省；`signal.to` 支持 `"host"` 哨兵 | docs/02 未定义这些字段/路由，按实现补齐，待回写 docs/02 |
| 2026-11-24 | 500 MB 暂用 blob sink 跑通（本机 Chromium 可承受） | fs/sw sink 属 M2；本机 500 MB 峰值内存占用偏高，跨机/移动端必须换 sink |

## 7.1 实测数据（本机 Chromium↔Chromium，loopback WebRTC，路径=局域网直连）

| 文件 | 用时 | 平均吞吐 | 哈希 |
|---|---|---|---|
| 10 MB | 2.5 s | ~34 Mbps | 一致 |
| 100 MB | 9.1 s | ~92 Mbps | 一致 |
| 500 MB | 28.0 s | ~150 Mbps | 一致 |

> 单文件 64 KiB 分片、HWM 8 MiB；加密在浏览器主线程，后续可评估 Worker 化。

## 8. 待办（需外部输入）

- [ ] 确认 `https://room.net.time-pack.com` 的反代已指向 5173 且透传 WebSocket Upgrade（G0 阻塞项）
- [ ] 手机/鸿蒙模拟器能否解析并连通该域名
- [ ] Apple 开发者账号（影响 TestFlight；不阻塞模拟器验收）
- [ ] 鸿蒙真机、iPhone 真机（发布前复验）
