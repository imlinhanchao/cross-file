# CrossFile 工程路线图 v0.1

> 配套：`01-design.md`（产品决策）、`02-protocol.md`（协议）
> 原则：**一套 TypeScript 核心 + 三个壳**；协议先跑通，再包壳；全端并行但按依赖排序。

---

## 1. 仓库结构

```
cross-file/
├── apps/
│   ├── web/                 # React + Vite，发送方/接收方全部 UI（唯一一套 UI 代码）
│   ├── desktop/             # Tauri 2，Win/macOS/Linux；内嵌 web 构建 + 原生保存/保活
│   └── mobile/              # Tauri 2，iOS/Android；分享面板、写盘、前台服务
├── packages/
│   ├── core/                # 协议核心（无 DOM 依赖，可单测）
│   │   ├── src/crypto/      # HKDF、AES-GCM 分片、SAS、增量 SHA-256
│   │   ├── src/protocol/    # 信令消息、帧编解码、manifest、状态机
│   │   ├── src/transfer/    # 分片器、流控、队列、续传 bitmap
│   │   ├── src/capability/  # 能力检测 + 阈值表
│   │   └── src/rtc/         # PeerConnection 封装、ICE 路径识别、TURN 配置
│   ├── signaling/           # Node 22 + ws；内存房间、限流、TURN 凭据签发
│   └── ui/                  # 共享 React 组件（房间页、队列、进度、错误）
├── infra/
│   ├── docker-compose.yml   # signaling + coturn
│   ├── coturn/turnserver.conf
│   └── deploy/              # 官方实例部署脚本
├── tests/
│   ├── e2e/                 # Playwright 双上下文，真实文件传输
│   └── perf/                # 500MB 吞吐与续传压测
├── design/                  # 设计稿与设计系统实现（tokens / base.css / screens / tools）
│   ├── tokens/tokens.css    # 唯一 token 来源，Web 与三端壳共用
│   └── screens/             # 5 张自包含设计稿 + screenshots/
├── docs/
│   ├── 01-design.md
│   ├── 02-protocol.md
│   ├── 03-roadmap.md
│   ├── 04-design-system.md
│   ├── FACT-SHEET-web-large-file-transfer.md   # 附录 A
│   └── prior-art-ephemeral-file-sharing.md     # 附录 B
├── package.json / pnpm-workspace.yaml
└── README.md
```

## 2. 技术栈（待确认，§6）

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 5.x 全覆盖 | 一套核心三端复用；协议逻辑可单测 |
| Web UI | React 19 + Vite + Tailwind CSS 4 | 生态成熟、Tauri 亲缘好、开发快 |
| 状态 | Zustand（轻） | 房间/队列状态简单，无需重型框架 |
| 单测 | Vitest | 与 Vite 同体系 |
| E2E | Playwright（Chromium/WebKit/Firefox 三引擎） | 真实浏览器覆盖 Safari 内核；可驱动双端 |
| 信令 | Node 22 + `ws`，Docker 单镜像 | 部署简单、团队熟悉；无数据库 |
| TURN | coturn（Docker）+ `static-auth-secret` 短凭据 | 成熟、可自托管、支持 ephemeral 凭据 |
| 桌面/手机壳 | Tauri 2（Rust 只写壳层胶水） | 体积小、复用 web 代码、官方支持 iOS/Android |
| 加密 | WebCrypto AES-256-GCM；增量哈希用 `@noble/hashes` | WebCrypto 无流式摘要，noble 补位 |
| 保存层 | 原生直写 / 文件系统 API（Chromium）/ Service Worker 流式下载（Safari 15.4+，自研）/ Blob 兜底 | 各浏览器写盘能力差异大，统一抽象成 sink |
| 视觉系统 | OKLCH 语义 token（`design/tokens/tokens.css`）+ 参考组件（`design/base.css`） | 浅/深双主题、对比度脚本校验；原生壳复用同一套 token |
| 鸿蒙 | **浏览器访问 Web 版**（v1 不开发原生） | 零开发成本；ArkWeb 的 WebRTC 待实测（风险 R1） |
| 许可证 | MIT | 已定 |

## 3. 里程碑（验收驱动，可并行）

> 时间按 1 名主力实现者 + Lead 并行推进估算；日期以你确认后重排。

### M0 — 骨架联调（≈2 天）
- monorepo、lint/format、CI（typecheck + vitest）。
- `signaling` 最小版：`create / join / approve / signal` 透传，内存房间。
- `core` 最小版：roomId/roomKey 生成、QR 链接生成、PeerConnection 建连、`data` 通道。
- `web` 两个页面：`/` 建房（显示二维码）、`/r/:id` 加入（自动建连）。
- **验收**：同一台机器两个 Chrome 标签页互传 10MB，哈希一致。

### M1 — 协议核心 + 500MB（≈4–6 天）
- 分片 + AES-GCM + manifest + 流控 + 进度。
- 能力握手 + 阈值表（先接 §5 初值）。
- 续传：断流检测、bitmap、60 s 重连。
- 全文件 SHA-256 校验、错误码与 UI 文案。
- 本地 coturn（docker-compose）跑通中继路径；`getStats` 识别路径标签。
- **验收**：AC1、AC2、AC3、AC7、AC8 全绿（Chromium↔Chromium）。

### M2 — 三端壳 + 保存路径（≈4–6 天）
- 桌面壳：Tauri 2 包 web 构建；原生写盘（Chromium 内核可用 FSA，壳层再兜底）；保活。
- 手机壳：Tauri 2 iOS/Android；保存到「文件」/相册，分享面板接收；前台服务保活。
- 能力检测按壳修正（`nativeShell: true`、真实内存/配额）。
- **Safari/iOS 保存原型**：自研 Service Worker 流式下载（WebKit 15.4+ 的 `ServiceWorkerDownloadTask`），验证 500MB 不占页面内存；验证通过后放宽能力阈值。
- **验收**：AC4、AC9；桌面壳 500MB 完整跑通。

### M3 — 产品化（≈3–4 天）
- 房间页完整交互：多接收方队列、文件×人矩阵、加入审批、移除成员、结束房间、空闲过期。
- 6 位码路径 + SAS emoji 比对。
- 错误与降级文案（中英双语待定）、空状态、加载态、无障碍基础（键盘/焦点/对比度）。
- **验收**：AC5、AC6 + 手工走查全流程。

### M4 — 发布与自托管（≈2–3 天）
- `docker-compose` 一键自托管（signaling + coturn + 反代示例）。
- 官方实例部署（域名、TLS、限流、TURN 配额）。
- 隐私说明页、README、自托管文档、许可证文件。
- 发布验收：在官方实例上跑 AC1–AC3 + AC8 审计。

### M5 — 发布后
- 鸿蒙真机/模拟器验证（ArkWeb WebRTC 与文件保存）。本机 CLT 26.0.0.821 + API 26 模拟器可直接跑 ArkWeb HAP 冒烟测试（附录 C §C），真机仍需复验。
- v1.x 候选：文本/剪贴板、文件夹、② 无外网局域网、Safari 大文件流式保存优化。

## 4. 测试矩阵

| 维度 | 取值 |
|---|---|
| 浏览器 | Chrome、Edge、Safari 27(桌面+iOS)、Firefox、鸿蒙 ArkWeb/华为浏览器 |
| 壳 | 无壳（Web）、桌面壳（Win/macOS/Linux）、手机壳（iOS/Android） |
| 网络 | 同网直连、跨网打洞、仅中继（本地 coturn）、弱网（netem 丢包 1%/延迟 80ms）、断流重连 |
| 文件 | 10MB、100MB、300MB、500MB；单文件、多文件；中文/emoji 文件名 |
| 场景 | 单接收方、多接收方顺序、加入审批、踢人、房间过期、发送方崩溃 |

自动化：Playwright 双上下文跑 AC1/AC3/AC5/AC6；AC2/AC8 在 CI 里用 docker-compose 起 coturn + strace 审计；性能脚本输出吞吐表格留档。

## 5. 风险清单

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | 鸿蒙 ArkWeb 的 RTCDataChannel 无官方文档（内核已是 Chromium M132/M144，大概率支持） | 「鸿蒙用户能用」待实测 | 本机已有 API 26 模拟器可做 ArkWeb 冒烟测试（附录 C §C）；若确实不支持 → 鸿蒙端降级或开发原生 HAP |
| R2 | Safari/iOS 目前只能靠 Blob 内存保存（现场报告 512MB 可过、1.4GB 标签页被杀） | 大文件接收失败 | 自研 Service Worker 流式下载（WebKit 15.4+ 已支持，StreamSaver.js 不可直接用）；M2 原型验证；未通过前维持保守阈值 |
| R3 | 移动端后台/锁屏挂起导致传输中断 | 体验断崖 | 原生壳前台服务 + 会话内续传；Web 端显式提示 |
| R4 | 数据通道真实局域网吞吐未知（实测 loopback 仅 111–161 Mbps） | 500MB 可能要 1 分钟以上 | M1 实测调参（分片/HWM）；必要时 LAN 路径改用本地 HTTPS 流（后续优化） |
| R5 | 浏览器未来把 WebRTC 纳入 Local Network Access 权限（Chrome 142 起已有该权限） | 局域网连接需授权，或被打断 | 关注 crbug 421223919；UI 预留权限引导 |
| R6 | 官方实例被白嫖中继 | 成本失控 | 限速、按 IP 内存限频、每会话总量上限、官方实例接收方上限 2 |
| R7 | App Store 审核（iOS 壳） | 上架延迟 | 提前准备隐私说明；iOS 先走 TestFlight；把壳做成可选的加分项 |
| R8 | TURN 成为合法风险点（匿名 + 任意内容 + 无记录） | 运营合规 | 官方实例只做限速兜底、明确 ToS、提供举报/关停机制；自托管为主 |
| R9 | 无数据库意味着服务器重启丢房间 | 传输中断 | 可接受（设计如此）；客户端给出清晰错误 |

## 6. 需要你确认的事项（同 `01-design.md` §10）

1. 技术栈：TS + React/Vite + Node/ws + Tauri 2 + coturn + MIT。
2. 产品名：CrossFile 代号 or 现在定名。
3. iOS 上架有无 Apple 开发者账号；没有的话手机端 v1 先出 Android + iOS 开发版。
4. 官方实例先本机 docker、M4 再上公网域名，是否 OK。
5. 是否现在开始 M0（约 2 天后可看到两个浏览器互传 10MB 的 demo）。

## 7. 开工顺序（确认后执行）

1. 建仓 + 工具链 + CI。
2. `packages/signaling` 最小实现 + `packages/core` 信令封装。
3. `apps/web` 建房/加入两页 + PeerConnection 建连（M0 demo）。
4. 进入 M1 协议核心。
