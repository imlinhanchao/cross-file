# CrossFile 开发计划（执行版）

> 本文件是开发期间**唯一活文档**：计划 + 实际进度 + 偏差记录。
> 上游事实源：`01-design.md`（决策 D1–D18、验收 AC1–AC9）、`02-protocol.md`、`03-roadmap.md`、`04-design-system.md`、附录 A/B/C。
> 目标：达到 §1 的 U1–U8「开发完成并可用」。

## 1. 完成定义（DoD）

| # | 判据 | 状态 |
|---|---|---|
| U1 | `docker compose -f infra/docker-compose.yml up -d` + `pnpm dev` 可起，`https://room.net.time-pack.com` 可访问 | ✅ 两条链路都实测：dev 域名 → nginx → Vite:5173 → `/v1/ws` → signaling:8788（curl 101、Playwright 10 MB 通过）；compose 起 signaling+coturn（healthy、日志恰 1 行、CLIENT PASS、down -v 干净） |
| U2 | 双端 100 MB 传完且 SHA-256 一致（主判据） | ✅ 本机双上下文 9.1 s，哈希一致 |
| U3 | 500 MB 走通，UI 显示真实路径标签 | ✅ 本机 500 MB 28 s（路径「局域网直连」）+ **500 MB 经 TURN 中继通过（路径「中继」、哈希一致）**；跨机真实网络待补 |
| U4 | 断流续传（50% 断开、60 s 内重连、只补缺片、哈希一致） | ✅ 本机 20 MB：传输中强断通道 → 重连 → 只补 295 片 → 哈希一致（Playwright AC3） |
| U5 | 6 位码 + 4 emoji SAS；结束房间即销毁 | ✅ 6 位码 + SAS 后经 ctrl 通道下发 roomKey（哈希一致）；结束房间后 guest 立即收 room_closed、房间从内存删除、迟到 join 被拒（Playwright AC7） |
| U6 | 零存储审计（无 DB / 无写盘 / 无访问日志） | ✅ `tests/audit/zero-storage.sh` 两种模式 RESULT PASS（本机 strace：0 写文件、0 DB、stdout 仅启动行；容器：read-only/非 root/无 mount/healthy/EROFS 写入失败） |
| U7 | 门禁全绿（typecheck / 单测 core ≥80% / 对比度 24/24 / 零硬编码色值 / e2e） | ✅ typecheck / 82 单测 / 对比度 24/24 / 零硬编码色值 / 默认 e2e 4 个通过（AC2 relay 用例按 `E2E_RELAY=1` 单独跑，已通过）；覆盖率阈值待核对 |
| U8 | 文档齐（README 可照做、自托管、隐私页、LICENSE） | ⚠️ README 命令可照做、`docs/self-host.md` 已由 infra-dev 交付并含实跑输出；隐私说明页与 LICENSE 文件待补 |

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
| WS9 | `apps/desktop`：Tauri 2 桌面壳 | 2.0 | ✅ 工程/原生写盘/关窗/菜单/deb，Web 侧已接线 |
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
| 2026-11-24 | 续传：发送方在发 manifest 前先算一次全文件 SHA-256，续传只重发缺失分片、`seq`/nonce 不变 | 发送方哈希必须覆盖整个文件；边发边哈希在乱序补片时无法接续 |
| 2026-11-24 | ctrl 通道新增 `sas-confirm` / `room-key {key, roomId}` / `key-ok` | docs/02 §3.5 只写了"人工比对后 H 通过 ctrl 发送 roomKey"，字段未定义 |
| 2026-11-24 | 发送前按接收方能力给软/硬上限提示（`judgeFile`），超硬上限禁用发送 | docs/01 D16 要求发送方提前看到限制提示 |
| 2026-11-24 | 桌面壳用配置声明窗口（保留 `dragDropEnabled:false`），信令地址经 `localStorage`/注入覆盖；根 `build` 只构建 Web，桌面用 `build:desktop` | Tauri 2 的 `WebviewWindowBuilder` 在本版本无 `drag_drop_enabled`；CI 不应默认打包 Tauri |

## 7.0 AC2 / AC8 证据（本地，已实测）

**AC2（仅 TURN）**：`docker compose up -d`（signaling + coturn）→ Vite 代理到容器 signaling（带 TURN 凭据）→ 双浏览器 `?relay=1`（`iceTransportPolicy: "relay"`）：
- 10 MB：PASS，路径「中继」，哈希一致
- 100 MB：9.6 s，路径「中继」，哈希一致
- **500 MB：PASS，路径「中继」，SHA-256 一致**（本机回环；真实 10 Mbps 网络 <10 分钟待实网验证）
- 复现：`E2E_RELAY=1 TURN_SECRET=... TURN_URIS='turn:127.0.0.1:3478?transport=udp' pnpm exec playwright test tests/e2e/ac2-relay.spec.ts`

**覆盖率门禁**：`pnpm test:coverage` 只统计 `packages/core`（协议核心），门槛 lines/functions/statements ≥80%、branches ≥70%，当前 **91.78% / 89.74% / 91.78% / 86.01%**（`rtc.ts` 浏览器 WebRTC 胶水由 Playwright 覆盖、`index.ts` 是 barrel，二者排除并注明原因）；已接入 `pnpm gate` 与 CI。

**AC8（零存储）**：`bash tests/audit/zero-storage.sh` → local 模式 RESULT PASS（strace：无 O_WRONLY/O_CREAT、无文件 write、无 DB 路径、stdout 仅 1 行、cwd 为空）；`SKIP_BUILD=1 bash tests/audit/zero-storage.sh --container` → 容器模式 RESULT PASS（read-only rootfs、非 root、0 mount、CapDrop ALL、no-new-privileges、EROFS 写入失败、down -v 干净）。

## 7.0.1 桌面壳（Tauri 2）实测

- `cargo check` ✅、`cargo test` ✅ 2/2（文件名穿越清洗、同名去重）
- `tauri build --no-bundle` ✅ release 二进制 5.47 MB；`--bundles deb` ✅ `CrossFile_0.1.0_amd64.deb`
- `dev:attach` 窗口创建（Wayland: title=CrossFile、configure 1200×857）无 panic
- IPC 端到端 ✅：`save_open` → 两段 offset `save_write` → `save_close` 内容逐字节正确；路径穿越清洗为单段文件名；`set_transfer_active` / `confirm_close` 正常
- Web 侧接线：`window.__CROSSFILE_NATIVE__` 标记能力包 → `native` sink 直写（`onChunk` 按 offset 调用 `save_write`，不再攒内存 Blob）；`close-requested` → 确认框 → `confirm_close`；菜单 `menu-action` 接「新建/结束房间」；传输期间 `set_transfer_active` 开关
- 信令地址解析顺序：`window.__CROSSFILE_SIGNALING_URL__` → `localStorage["crossfile.signalingUrl"]` → 桌面默认 `ws://127.0.0.1:8788/v1/ws` → 同源；生产自托管改地址用设置页/该 key（M4 待办）
- 未验证：GUI 内 500 MB 实跑（本机无 xvfb/截图能力，需人工或 tauri-driver）、AppImage 打包、macOS/Windows 构建

## 7.0.2 AC6 多接收方（实测）

- 矩阵：新文件默认勾选所有已加入接收方，`assignments[fileId] = guestId[]`；未勾选的文件不会出现在该接收方的 manifest 里。
- 队列：`transferChain` 串行执行，`开始发送` 按加入顺序排队；guest 先接受也只会排进链，不会并发。Playwright 用例断言「guest1 done 时 guest2 仍未 done」，随后两人 SHA-256 均与源文件一致。
- UI：文件行右侧是「文件 × 人」胶囊（`chip-toggle`，选中打勾），底栏显示「发给 N 个接收方 · 共 X MB · 逐个发送」。

## 7.0.3 手机壳（Tauri 2 Android）实测

- `cargo check --target aarch64-linux-android` ✅、`cargo build --lib` ✅ 产出 `.so`、`cargo test` 3/3 ✅
- `tauri android init` ✅；`tauri android build --debug` ❌ 沙箱禁 inotify（非工程问题）；等价 Gradle 流程 ✅ `BUILD SUCCESSFUL`，`app-arm64-debug.apk` 116 MB（`com.crossfile.mobile`、minSdk 24、targetSdk 37，含 `libcrossfile_mobile_lib.so`、`KeepAliveService(dataSync)`、`ACTION_SEND`）
- 保存：与桌面同签名的 `save_*` 命令，目标 `app_data_dir()/downloads`；MediaStore 导出 TODO
- 保活：`navigator.wakeLock` + Android dataSync 前台服务（进 APK，运行时未验）
- 分享接收：intent-filter + `ShareIntake` 骨架已进 APK，JS 桥未接
- 模拟器：本机无 `/dev/kvm`，install/启动/500 MB 未执行

## 7.0.4 AC4 Safari 实测（结论：真实 Safari 可用；Playwright WebKit 是假阴性）

**最终验证（2026-11-24，真 Safari 27.0.1 on macOS 27.0.1，mac-mini）**
- 房间链接在 Safari 中打开 → 信令 join → 房主批准 → 100 MB 传输（双方 `?relay=1`，本机 coturn `turn:192.168.50.200:3478`）
- 传输完成，路径标签「中继」；**Chrome 侧 SHA-256 与 Safari 页面上报的 SHA-256 完全一致**（`e291f56a…`，104857600 bytes），吞吐约 74 Mbps
- 证据：宿主 `HOST DONE/HASH MATCHES EXPECTED: true`；Safari 通过 dev-only `?report=` 把自身计算结果回传（`[cf-report] tag=guest-done sha=e291f56a… path=relay`）
- iOS 27.2 模拟器 Safari 同样通过：宿主与 iOS 端 SHA-256 均为 `a5dd4376…`，100 MB、路径 relay
- **直连路径（非中继）**：Safari 桌面 100 MB 与 **500 MB** 均通过，路径标签 `direct`，双方 SHA-256 一致；500 MB 实测吞吐 ≈19.2 MB/s（≈153 Mbps），Safari 内存中完成并计算哈希未崩溃（保存点击仍未验）

**为什么之前 Playwright WebKit 一直失败（已排除）**
- Playwright 的 WebKit 二进制**不会向局域网发 UDP**：用 `stun:192.168.50.200:9999` 指向我们自己的 UDP 监听器，监听器一包都没收到；同一台机器的 Node 进程发 STUN 却能收到 coturn 响应。
- 因此「直连 ICE failed」与「TURN 零 relay 候选」都是测试载具（Playwright WebKit 的 macOS 沙箱/本地网络权限）造成的，不是 WebKit/CrossFile 的问题。
- 真实 Safari 经同一 TURN 能拿到 `relay/udp@192.168.50.200` 并完成上述 100 MB 传输。

**剩余**：Safari 内的「保存」点击与磁盘落盘（需用户手势，未自动化）、iOS 模拟器/真机、500 MB 分级提示的端到端、直连（非中继）路径的 Safari 表现。
**测试辅助**：`?autoaccept=1` 与 `?report=<url>` 仅在 `import.meta.env.DEV`（dev server）下生效，生产构建会被剥离；dev server 的 `/__report` 端点只在 `vite serve` 时注册。

## 7.0.5 接收端能力门禁（docs/01 §6 / D16）

- 接收方收到 manifest 后用自身能力包 `judgeFile(totalBytes, caps)` 判定：超**硬上限**直接回 `error TOO_LARGE` 并拒绝；超**软上限**在确认页显示风险卡（含具体 MB 与建议），按钮改为「仍要接收」。
- 文案按平台区分：iOS 用 `docs/04` §15 的 iPhone 文案，其余用通用保守文案。
- 自动化：`tests/e2e/capability-warn.spec.ts` 把 guest 伪装成 iPhone（UA + touch + 无 FSA），发送 150 MB → 断言 `risk.level=warn`、软上限 100 MB、按钮「仍要接收」，接收后哈希一致（21 s）。
- Safari 桌面 100 MB 实测与 iOS 模拟器 100 MB 实测见 §7.0.4；「保存到磁盘」仍需人工点击（Safari 要求用户手势）。

## 7.0.6 M3 产品化细节（已完成）

- **对话框**：`ui/Dialog.tsx`（`role=dialog`/`aria-modal`、焦点陷阱、Esc 取消、关闭后焦点还原）。用于：结束房间确认（危险操作）、发送前能力风险确认、移除接收方、接收方「仍要接收」确认。
- **键盘**：⌘/Ctrl+Enter 开始发送；Esc 打开结束房间确认（对话框内 Esc 只关闭对话框，`defaultPrevented` 防止重复处理）。
- **移除接收方**：接收方行新增移除按钮（带 `aria-label`），确认后信令 `remove`、Peer 关闭、UI 标记已移除。
- **无障碍**：新增 `tests/e2e/a11y.spec.ts`（@axe-core/playwright，WCAG 2.1/2.2 A/AA），宿主房间、接收确认页、结束房间对话框 **0 serious/critical**；期间修掉 QR `aria-label` 缺 role、文字三层灰阶对比度不足（`--text-secondary`→gray-700、`--text-muted`→gray-600）、路径「局域网」徽标对比度（mint-800）三处问题。
- 对比度校验脚本扩到 25 组（文本一律 ≥4.5:1），`design/README` 与 `docs/04` §5/§6 同步。
- 回归：7 个 e2e 通过（AC2 中继按 `E2E_RELAY=1` 单独通过）、95 单测、门禁全绿；`pnpm build` 产物中确认 dev-only 的 `autoaccept` 钩子已被剥离。

## 7.0.7 生产单源（已完成）

`packages/signaling/src/static.ts`：配置 `STATIC_DIR` 时同一进程服务前端与 `/v1/ws`——SPA 回退、`assets/*` immutable 缓存、`Referrer-Policy: no-referrer`、严格 CSP、`Permissions-Policy`、无访问日志、无写盘。新增 7 个单测；本地用生产构建 `apps/web/dist` + Playwright 双上下文跑通 10 MB（哈希一致）；**Docker 生产镜像实测**：镜像内 `/app/public` 含 index.html，容器 `http://127.0.0.1:18788` 页面/安全头/SPA/传输全部通过，零存储审计仍 PASS。Dockerfile 构建阶段增加 `vite build` 并把 dist 放进运行时镜像（`STATIC_DIR=/app/public`）；`docs/self-host.md` 补生产单源说明；新增 `.github/workflows/ci.yml`（门禁/e2e/零存储审计三个 job）。

## 7.0.8 桌面壳运行取证：Linux WebKitGTK 无 WebRTC（AC9 关键发现）

用 debug-only `CROSSFILE_DEV_JOIN` + devUrl + 诊断回传，让 Tauri 应用真实加载接收页并上报自身状态：
- 页面/JS/信令 join 正常，guest 能力包 `nativeShell: true`、`saveStrategies: ["native","blob"]`；
- 但 webview 内报 `unhandled: ReferenceError: Can't find variable: RTCPeerConnection`，host 端 WebRTC 停在 `new`；
- 结论：Ubuntu 的 WebKitGTK 构建不含 WebRTC（ADR 0008）。这不是沙箱显示问题——窗口与页面都起来了。
- 产品处理：Web 端增加 WebRTC 预检（不支持时直接展示替代方案，e2e `webrtc-missing.spec.ts`），
  Linux 桌面壳文档改为「用浏览器打开单源地址」，Windows/macOS 壳待真机复验。
- AC9 在 Linux 上的 500 MB GUI 实跑因此**不可达**，除非改用 Electron/CEF 或自带 WebRTC 的 WebKit；列入 v2 评估。

## 7.0.9 Linux 桌面壳：Electron 方案（AC9 达成）

ADR 0009：`apps/desktop-electron/` 用 Electron（Chromium）替代 WebKitGTK 壳，preload emulates Tauri 的
`window.__TAURI__` 桥，前端零改动。实测：
- 100 MB：host `HASH MATCHES EXPECTED: true`，落盘文件 sha256 一致；
- **500 MB：路径「局域网直连（lan）」，host `sha256=ccd606e7…`，落盘 524 288 000 B、sha256 完全一致**；
- 复现：`CROSSFILE_URL=<link> HOME=<writable dir> electron apps/desktop-electron --no-sandbox`。
剩余：Windows/macOS 的 Tauri 壳真机验证；Linux Electron 打包产物（AppImage）与签名。

## 7.1 开发链路（已实测）

```
https://room.net.time-pack.com  --TLS-->  nginx (既有反代)  -->  Vite :5173
                                                                  └── /v1/ws  --ws--> signaling :8788
```
- `curl -k --http1.1 -H 'Upgrade: websocket' https://room.net.time-pack.com/v1/ws` → **101 Switching Protocols**
- `E2E_NO_WS=1 E2E_BASE_URL=https://room.net.time-pack.com E2E_IGNORE_TLS=1 pnpm exec playwright test tests/e2e/m0-transfer.spec.ts` → 1 passed（10 MB，哈希一致）
- 本机 8787 被一个无关服务占用（返回 `{"error":{"code":"not_found"…}}`），故 signaling 默认端口改为 **8788**；`pnpm dev` 与 Vite 代理都已指向 8788。

## 7.2 实测数据（本机 Chromium↔Chromium，loopback WebRTC，路径=局域网直连）

| 文件 | 用时 | 平均吞吐 | 哈希 |
|---|---|---|---|
| 10 MB | 2.5 s | ~34 Mbps | 一致 |
| 100 MB | 9.1 s | ~92 Mbps | 一致 |
| 500 MB | 28.0 s | ~150 Mbps | 一致 |

> 单文件 64 KiB 分片、HWM 8 MiB；加密在浏览器主线程，后续可评估 Worker 化。

## 7.3 剩余工作（按优先级，2026-11-24 更新）

1. **AC9 运行态验证（阻塞于环境）**
   - 桌面壳：GUI 内真实 500 MB 传输与写盘。本机 Wayland 有显示但没有输入注入工具；可用 `tauri-driver`（需 `sudo apt install webkit2gtk-driver`）或人工点一次。
   - 手机壳：模拟器安装/启动/500 MB。本机无 `/dev/kvm`，需真机或带 KVM 的机器；APK 与等价 Gradle 流程已通过。
2. **AC4 收尾（需人工手势/真机）**：Safari 内点「保存」落盘（Safari 要求用户手势，自动化会被拦）、iOS 真机保存、500 MB 分级提示在真机上的端到端。
3. **M4 上线（需你的基础设施）**：官方实例域名/TLS/限流/TURN 配额；`TURN_EXTERNAL_IP` 必须是公网 IPv4；`infra/deploy/Caddyfile.example` 已就绪；本机 compose 已验证。
4. **M3 打磨**：统一 Dialog（结束房间/风险确认/踢人）、axe 无障碍扫描与键盘走查、错误态文案全覆盖。
5. **真实网络验收**：跨机同 LAN 500 MB ≥60 Mbps、仅中继 10 Mbps 下 500 MB <10 分钟、netem 弱网用例。
6. **手机壳后续**：MediaStore 导出、分享 intent 的 JS 桥、iOS 壳（需 macOS/Xcode 构建）。

## 8. 待办（需外部输入）

- [ ] 确认 `https://room.net.time-pack.com` 的反代已指向 5173 且透传 WebSocket Upgrade（G0 阻塞项）
- [ ] 手机/鸿蒙模拟器能否解析并连通该域名
- [ ] Apple 开发者账号（影响 TestFlight；不阻塞模拟器验收）
- [ ] 鸿蒙真机、iPhone 真机（发布前复验）
