# CrossFile 开发计划（执行版）

> 本文件是开发期间**唯一活文档**：计划 + 实际进度 + 偏差记录。
> 上游事实源：`01-design.md`（决策 D1–D24、验收 AC1–AC15）、`02-protocol.md`、`03-roadmap.md`、`04-design-system.md`、附录 A/B/C。
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
| U7 | 门禁全绿（typecheck / 单测 core ≥80% / 对比度 33/33 / 零硬编码色值 / e2e） | ✅ typecheck / 82 单测 / 对比度 33/33（2026-11-26 从 25 组扩至 33 组）/ 零硬编码色值 / 默认 e2e 4 个通过（AC2 relay 用例按 `E2E_RELAY=1` 单独跑，已通过）；覆盖率阈值待核对 |
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
剩余：Windows/macOS 的 Tauri 壳真机验证；Linux Electron 签名与品牌图标（AppImage 已产出并用解包版实跑 100 MB 通过，见 docs/desktop.md §5.1）。

### macOS Tauri 壳进展（2026-11-24）
- 在 mac-mini 上从 LAN 拉取仓库：`pnpm install --frozen-lockfile` ✅（修掉 Electron 壳缺 importer 的锁文件缺陷后）、`pnpm --filter @crossfile/web build` ✅、`cargo build --no-default-features` ✅、`tauri dev` 窗口启动 ✅；
- 新增 shell 日志 `[shell] page load start/false url=…` 证明 WKWebView 已加载房间页；
- 端到端 100 MB 未跑完：非交互 shell 启动 GUI 需要经 Terminal（已用 `open -a Terminal` 绕过），但房间链接每 600 s 轮换与 GUI 冷启动存在时序竞争；下一步可用「先用 blank 页预热、再固定房间 15 分钟」的编排重试。
- 深挖（debug 探针，macOS WKWebView 内取证）：页面加载完成、**React 已挂载**（#root 1885 字符）、
  `window.__crossfile` 存在、`error` 事件列表为空、**wss:// 连接可以建立**（探针 open）；`CROSSFILE_DEV_JOIN`
  harness 导航后 URL 的 `#fragment` 也保留。但接收页的 Controller 没有发起房间加入（host 端零 guest、
  也没有周期诊断上报），原因未定——下一步用 Safari 远程检查器看 WebKit 控制台，或改用生产单源构建
  （`tauri build` + 内嵌 dist）再验。
- 结论：macOS Tauri 壳「构建 + 窗口 + 页面 + 网络」已证明，**传输链路仍未打通**；Linux 已由 Electron 达成 AC9。

## 7.0.10 D16 配额探测与暗色无障碍（已完成）

- 能力包新增配额探测：Web 在 `hello/create/join` 前用 `navigator.storage.estimate()` 把
  `storageQuotaMB` 填进 caps；`judgeFile` 在平台阈值之外再做配额判断（超配额 80% 警告、超配额拒绝），
  接收端拒绝时用**真正生效的边界值**（配额或硬上限）提示「约 N MB」。
- 接收端拒绝时发送 ctrl `error(TOO_LARGE)`，发送端随即将阶段切到 `error` 并给出可行动文案（此前只显示错误条但仍显示"已加入"）。
- 新增 e2e：`quota-reject.spec.ts` 把 guest 的 `navigator.storage` 伪装成 5 MB 配额，发 20 MB →
  接收端在写入任何字节前拒绝（提示约 5 MB），发送端同步进入 error；`m0` 断言 caps 里带真实 quota。
- 无障碍：axe 扫描新增**暗色主题**一轮（host 房间 light + dark 均 0 serious/critical）。

## 7.0.11 SAS 确认超时（已完成）

docs/02 §4.5 的 60 秒未确认超时落地：guest 收到 4 emoji 后计时，host 在发出 SAS 后也计时；
超时即 `error` 状态、关闭连接（host 同时移除 guest），文案给下一步；e2e `sas-timeout.spec.ts`
用 `?sasTimeoutMs=800` 在 6 秒内验证「双方都中止且都有可行动提示」。新增 `timeout.test.ts` 2 个单测。

## 7.0.12 macOS Tauri 壳打通 500 MB（根因与修复）

上一轮停在「页面/React/WSS 都正常，但接收 Controller 不发起加入」。后来用 shell 内探针读取 `window.__crossfile.snapshot()`
拿到真正原因：`phase=error, error="Error: signaling connection failed"` —— 原生壳里 `signalingUrl()` 优先返回
**`ws://127.0.0.1:8788/v1/ws` 默认值**，而不是页面同源地址；macOS dev 壳上没有本地信令服务，于是连不上。

修复（也是产品缺口）：
- 桌面壳新增 `get_shell_config` 命令，返回 `signaling_url`（`CROSSFILE_SIGNALING_URL` 可覆盖，默认 `ws://127.0.0.1:8788/v1/ws`）；
- Web 侧新增 `resolveSignalingUrl()`：原生壳且没有注入/存储地址时向壳要配置，再建连；兼容 Rust 的 snake_case 字段；
- 单测覆盖 shell 配置归一化与解析顺序。

实测（macOS，Tauri 2 + WKWebView，LK 用 `CROSSFILE_SIGNALING_URL=wss://room.net.time-pack.com/v1/ws`）：
- 100 MB：host `HASH MATCHES EXPECTED: true`，`~/Downloads/ac4-100mb.bin` sha256 一致；
- **500 MB：路径「直连」，host `sha256=a2cff034…`，落盘 524 288 000 B、sha256 完全一致**。
因此 AC9 桌面侧在 Linux（Electron）与 macOS（Tauri）双双达成；剩 Windows 壳与手机壳。

## 7.0.13 手机壳无人值守验收钩子（进行中）

手机壳 debug 构建新增 `CROSSFILE_DEV_JOIN` / `CROSSFILE_DEV_AUTOACCEPT`（配合同样 debug-only 的
`get_shell_config.debug_auto_accept`，由 Web 端读取后才允许自动接收；release 永不开启），并在 iOS
模拟器上尝试「构建 → 安装 → simctl launch（带环境变量）→ 自动加入 → 原生落盘」全链路。
手机壳新增 Rust 单测（文件名穿越防护、重名去重、init script 注入信令地址，3 个全过）。

**iOS 模拟器实测进展（2026-11-25）**：在 mac-mini 上打通了 iOS 壳构建链——
`rustup target add aarch64-apple-ios-sim`、`tauri ios init`（自动安装 libimobiledevice 等 brew 依赖）、
`tauri ios build --debug --target aarch64-sim` 均成功（需要在 `gen/apple/tauri` 放一个转调 Tauri CLI 的
shim，因为 Xcode 的 "Build Rust Code" phase 会执行 `node tauri ...`；仓库不生成该文件，属 Tauri 生成工程的
本地注意事项）。装进 iPhone 17 模拟器并用 `simctl launch` + `SIMCTL_CHILD_CROSSFILE_DEV_JOIN/AUTOACCEPT`
启动后，**iOS 壳成功加入房间**（host 侧看到 guest joined / manifest 已发送），WKWebView 能建 RTCPeerConnection
（日志里 `peer-connection` 存在，`dataChannelsOpened=0`）。
但**数据通道未打开、传输没有开始**：目前判断是模拟器 ↔ Linux 的 ICE 候选/中继问题（已临时拉起 coturn 仍未
打通）；另外远程 dev 页面下 Tauri 2 默认拒绝 IPC（`event.listen not allowed on window "main"`），已加
`capabilities/dev-remote-acceptance.json`（仅允许 dev 域）并让前端 listen 失败时优雅降级。
**后续（同日）**：把两端都强制 `?relay=1` 后 iOS 壳与 Linux 的 ICE 打通（host `connected`、路径「中继」）——
**100 MB 接收成功**：文件落在模拟器 App 沙盒 `Library/Application Support/com.crossfile.mobile/downloads/`，
sha256 `0e9ae831…` 与发送方完全一致。**500 MB 跑到 498/524 MB 时 App 进程被系统终止**（无 crash report，
疑似 WKWebView/IPC 内存 jetsam；100 MB 正常），下一步用 Instruments 看内存曲线，或分块落盘后及时释放。
针对 500 MB 的三个修复（本轮）：
1. **IPC 载荷**：native sink 原来 `Array.from(bytes)` 把每 256 KB 分片变成 26 万个数组成的 JSON 数组；改为
   **base64 字符串**（Rust 用 `base64` crate 解码），序列化体积与 GC 压力大幅下降；
2. **接收端背压**：枚举已有 `pause`/`resume` 协议消息——接收端未处理帧超过 24 MB 时发 `pause`、降到 4 MB 发
   `resume`，发送端 `sendFile` 通过 `waitIfPaused` 真正停/续；
3. **本地源加入**：远程 https 页面在 iOS 上被 Tauri ACL 拒绝自定义命令（`save_open not allowed`），改为
   调试壳把房间链接解析后**在应用自身 origin 内**打开（房间号/key 走 dev-only query `devroom`/`devkey`），
   这样 native IPC 可用；生产构建需 shell 的 debug 标志才会认这两个参数。
结果：两轮 500 MB 中继测试仍以 **App 进程在中后段被系统终止**告终（无 500 MB 落盘；100 MB 仍稳定通过）。
下一步：把 `report=` 透传进本地页拿到 webview 内的 phase/lastError 与内存曲线，或改成分块写盘后强制
释放/使用可增长缓冲，定位是 WebKit 内存上限还是 IPC/GC。

**500 MB 最终通过**：根因是「本地源调试加入」路径漏了派生 `sessionKey`（只设了 roomKey/roomIdBytes），
导致所有分片解密失败、静默丢弃（帧计数 8000 但进度 0、无落盘、无错误）。补上统一的
`deriveSessionKey` 后，500 MB 中继测试：**host `HASH MATCHES EXPECTED: true`（sha256 `f5b7ea08…`）、
iOS 落盘 524 288 000 B 且 sha256 完全一致、guest 阶段 done**。中间还修掉：base64 IPC 载荷、
接收端 pause/resume 背压、native 壳探测晚于首屏时改用 `get_shell_config` 兜底、诊断上报。
结论：iOS 手机壳（模拟器）**500 MB 全链路通过**；
Android 壳仍受本机无 KVM、AVD 只读锁、arm64 APK 限制。

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

## 7.4 任意互传（阶段 1）变更记录（2026-11-26）

**决策来源**：ADR 0010；`docs/01` 修订 D6–D9/D18 并新增 D19–D24；`docs/02` 升 v2（不兼容 v1）。

**范围（本次实现）**
- 房间模型改为「管理员 + 成员」；Web 端 Host/Guest 两页合并为统一 Room 页，首页改为「创建房间 / 加入房间」。
- 协议 v2：`members` 广播、`profile` 昵称、`transferId`、任意成员间 `signal` 的形状、`rejoinToken`（成员 60 秒
  重连）、版本门禁 `VERSION_MISMATCH`；阶段 1 只启用「管理员↔成员」。
- 传输：管理员↔成员双向；同一对设备串行（`BUSY` 排队）、不同对可并发；对称续传（接收方发 bitmap、
  发送方补片）。
- 显示名：默认 `平台 · 4 位代号`、入房前/会话中可改、房内查重、本地记忆、可「忘记」。
- 隐私：S 可见元数据新增成员数、显示名、平台、连接关系（不落盘）；`docs/01` §5、`/privacy`、README 同步；
  零存储审计标准不变。
- 部署：房间成员上限改为可用 `MAX_MEMBERS` 环境变量配置（官方实例 2 / 自托管默认 4，不含管理员；
  旧名 `MAX_GUESTS` 兼容，非法值启动即失败），docker compose、PM2 与 `infra/.env.example` 已接线。
- **不在范围**：阶段 2（成员↔成员互传、懒建连 mesh、管理权移交、自动接收开关）。

**门禁（2026-11-26 实测）**
- ✅ `pnpm gate`：prettier / typecheck（core、ui、signaling、web 全过）/ **178 单测（14 文件，core 覆盖率 92.46% stmts / 85.44% branch）** / 对比度 33/33 / 零硬编码色值。
- ✅ `pnpm e2e`：**20 passed / 1 skipped**（跳过项为 AC2 relay：本机无 coturn），约 2.0 min；AC10 另跑 `E2E_FILE_MB=500` → 双向 500 MB 1 passed (2.0 min)。AC10–AC15 证据见 `docs/06-acceptance.md`。
- ✅ `bash tests/audit/zero-storage.sh` → RESULT PASS：8 步真实 v2 会话（create → 2×join/approve → members 广播 → profile 改名广播 → 任意成员信令 → close），0 写盘 / 0 DB / stdout 仅 1 行启动日志。
- ✅ `bash tests/audit/zero-storage.sh --container` → RESULT PASS：只读 rootfs、非 root（1000:1000）、无 volume/mount、CapDrop ALL、no-new-privileges、健康检查、同一 8 步 v2 会话、容器内写盘 EROFS、`down -v` 干净。本机沙箱需 `DOCKER_BUILDKIT=0`（buildx 活动文件只读）；构建需 Dockerfile 的 `--ignore-scripts`（见偏差记录）。
- ✅ `pnpm build`（Web 生产构建 465 kB / gzip 145 kB）。

**偏差记录（2026-11-26）**
- **AC6 断言调整**：v2 修订 D9 后「不同对可并发、同一对串行」，原「guest1 完成前 guest2 不开始」不再成立；同对串行改由 AC11 覆盖，AC6 只断言矩阵与两人哈希一致。
- **AC12b 暴露 core bug 并已修**：`waitForCapacity()` 在已关闭 data channel 上死循环（`bufferedAmount` 不下降）导致发送方重建后永久卡 paused；`waitForDrain` 监听 `close`、`waitForCapacity`/`sendFile` 关闭即抛错，发送循环在新通道重试。
- **AC13 暴露 Web bug 并已修**：成员端 `join_ok` 先 `applyMembers()` 覆盖 `selfName` 再发 `profile`，本地记忆名永远发不到服务端；改为先保存 `localName` 再广播。
- **e2e 限流逃生口**：`dev.ts` 新增 `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`（仅测试 webServer 设为 100000；生产默认 120/60 s 不变）。
- **沙箱 inotify 兜底**：`tests/e2e/fs-watch-fallback.cjs` 在 EMFILE/ENOSPC 时退化为轮询，`playwright.config.ts` 自动加载，正常机器 no-op。
- **容器构建修复**：pnpm 12 对 workspace root 的 electron-builder 链（即使 `--filter` 也会安装）报 `ERR_PNPM_IGNORED_BUILDS`；`infra/signaling/Dockerfile` 的 `pnpm install` 加 `--ignore-scripts`（bundle 与 Vite 构建不需要 lifecycle script），容器审计重建后 PASS。
- **未验证项**：AC2 relay（本机无 coturn）；管理员 WS 断线/成员 `rejoinToken` 重连只有服务端单测、无浏览器实测钩子；壳层（Tauri/Electron/手机）仍靠人工 AC9（本次未重跑，壳加载同一 Web 产物）；阶段 2 未实现（协议/状态已按 member 化预留）。
- **AC11 用例依赖大文件窗口**：默认用 80 MB 制造排队窗口（本机稳定），极快机器可用 `E2E_QUEUE_MB` 放大。

## 8. 待办（需外部输入）

- [ ] 确认 `https://room.net.time-pack.com` 的反代已指向 5173 且透传 WebSocket Upgrade（G0 阻塞项）
- [ ] 手机/鸿蒙模拟器能否解析并连通该域名
- [ ] Apple 开发者账号（影响 TestFlight；不阻塞模拟器验收）
- [ ] 鸿蒙真机、iPhone 真机（发布前复验）
