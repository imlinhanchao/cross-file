# CrossFile（暂定代号）

> 临时大文件、扫码即传、端到端加密、服务器不存一个字节。
> 跨平台：Web（零安装接收）/ 桌面（Tauri）/ 手机（Tauri）/ 鸿蒙（浏览器）。

**当前状态：M0 已跑通（2026-11-24）。** 两个浏览器经本机信令 + WebRTC 数据通道互传 10 MB / 100 MB / 500 MB，密文分片 AES-256-GCM、全文件 SHA-256 双向校验一致，界面显示真实路径标签（局域网直连 / 直连 / 中继）。设计与验收细节见 [docs/05-development-plan.md](docs/05-development-plan.md)。

**2026-11-26：任意互传阶段 1 已实现。** 房间模型从「发送方 + 接收方」改为「管理员 + 成员」，管理员与成员之间可以双向互传（成员之间互传留在阶段 2）；协议升 v2、不兼容 v1（旧页面会收到明确的 `VERSION_MISMATCH` 并提示刷新），Web 端 Host/Guest 两页合并为统一 Room 页。验收：`pnpm gate` 全绿（178 单测）、`pnpm e2e` 20 passed / 1 skipped（AC2 relay 需 TURN 环境）、AC10 双向 500 MB 哈希一致、零存储审计 PASS。生产实例：**https://file.time-pack.com**（GitHub Actions → PM2，部署与验收记录见 [docs/06-acceptance.md](docs/06-acceptance.md)）。决策见 [ADR 0010](docs/adr/0010-any-to-any-room.md)。

**发布与下载：** GitHub Releases 提供服务器解压包 / 服务器单二进制、Linux AppImage、Windows MSI/EXE、macOS DMG、Android APK（`SHA256SUMS` 校验）；打 tag 即出 draft release，**发布 release 即部署生产**。流程见 [docs/release.md](docs/release.md)。

```bash
pnpm install
pnpm dev                   # 信令 :8788 + Web :5173（一起起）
pnpm dev:signal            # 只起信令：ws://127.0.0.1:8788/v1/ws（零存储、无数据库）
pnpm dev:web               # Web：http://127.0.0.1:5173
pnpm gate                  # typecheck + 单测 + 对比度 33/33 + 零硬编码色值
pnpm e2e                   # Playwright 双浏览器真实传输（默认 10 MB）
E2E_FILE_MB=500 pnpm e2e   # 500 MB 用例

# 一键自托管（signaling + coturn，零存储、只读根文件系统）
cp infra/.env.example infra/.env   # 填 TURN_SECRET / TURN_URIS / PUBLIC_HOST
docker compose -f infra/docker-compose.yml up -d --build
bash tests/audit/zero-storage.sh   # 零存储审计（本机 strace）
SKIP_BUILD=1 bash tests/audit/zero-storage.sh --container   # 容器只读审计
E2E_RELAY=1 TURN_SECRET=... TURN_URIS='turn:127.0.0.1:3478?transport=udp' \
  pnpm exec playwright test tests/e2e/ac2-relay.spec.ts       # 仅中继路径

# 桌面壳（Tauri 2，Linux 需 webkit2gtk-4.1-dev）
pnpm --filter @crossfile/web build
pnpm --filter @crossfile/desktop build:nobundle   # 只出二进制
pnpm --filter @crossfile/desktop build            # deb/rpm 等安装包
pnpm --filter @crossfile/desktop dev              # 开发模式（自带 Web dev server）

# Linux 桌面壳（Tauri 的 WebKitGTK 无 WebRTC，改用 Electron；见 docs/desktop.md §5.1）
CROSSFILE_URL='http://127.0.0.1:8788' ./node_modules/.bin/electron apps/desktop-electron
pnpm --filter @crossfile/desktop-electron package:linux   # 出 AppImage（需 electron-builder 镜像环境）

# 手机壳（Android；需 JDK+SDK+NDK，见 docs/mobile.md）
source scripts/dev-env.sh
pnpm --filter @crossfile/mobile android:init       # 首次生成 android 工程
pnpm --filter @crossfile/mobile android:build:debug

# 经开发域名跑（需 Vite 5173 在跑，反代已把域名指到 5173）
E2E_NO_WS=1 E2E_BASE_URL=https://room.net.time-pack.com E2E_IGNORE_TLS=1 \
  pnpm exec playwright test tests/e2e/m0-transfer.spec.ts
```
开发期 HTTPS 由既有反代提供：`https://room.net.time-pack.com` → `127.0.0.1:5173`（`allowedHosts` 已开，`/v1/ws` 走 Vite 代理）。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/01-design.md](docs/01-design.md) | 产品定位、非目标、24 条已定决策、动态能力限制、隐私承诺、验收标准 |
| [docs/02-protocol.md](docs/02-protocol.md) | 信令协议 v2、密钥与加密、分片帧格式、续传状态机、ICE 路径、零存储约束 |
| [docs/adr/0010-any-to-any-room.md](docs/adr/0010-any-to-any-room.md) | ADR 0010：房间内任意互传（管理员 + 成员、协议 v2、两阶段路线） |
| [docs/03-roadmap.md](docs/03-roadmap.md) | 仓库结构、技术栈、M0–M4 里程碑、测试矩阵、风险清单 |
| [docs/04-design-system.md](docs/04-design-system.md) | 设计系统：设计意图、OKLCH token、排版、组件与状态、无障碍、平台适配、文案 |
| [docs/deploy-official-instance.md](docs/deploy-official-instance.md) | 官方实例部署清单：前置条件、.env、反代、验收命令、运维边界、中继成本 |
| [docs/release.md](docs/release.md) | 发布流程：tag → draft release（server tarball/二进制、桌面、Android）→ 发布即部署 |
| [.github/workflows/release.yml](.github/workflows/release.yml) | 打包：tag 驱动，构建全部产物 + SHA256SUMS，创建 draft release |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | 部署：release published → 下载 release 资产 → scp → PM2 重载 + 健康检查 |
| [docs/desktop.md](docs/desktop.md) | Tauri 2 桌面壳：依赖、开发/打包命令、原生写盘 IPC、关窗保护、菜单 |
| [docs/mobile.md](docs/mobile.md) | Tauri 2 手机壳：Android 构建、原生写盘、前台保活、分享接收、限制 |
| [design/](design/README.md) | 设计稿与出图流水线：6 个画面（统一 Room 页）、token、对比度校验、截图脚本 |
| [docs/FACT-SHEET-web-large-file-transfer.md](docs/FACT-SHEET-web-large-file-transfer.md) | 附录 A：浏览器/平台能力的实测事实（Chrome 157、Safari 27） |
| [docs/prior-art-ephemeral-file-sharing.md](docs/prior-art-ephemeral-file-sharing.md) | 附录 B：14 个竞品的拓扑、存储、上限、许可、活跃度 |
| [docs/FACT-SHEET-safari-harmonyos.md](docs/FACT-SHEET-safari-harmonyos.md) | 附录 C：Safari 流式保存、鸿蒙 ArkWeb 内核版本、本机鸿蒙模拟器 |

## 一句话边界

做：同步、点对点、零服务器存储、500MB 级、一次性传输、房间内双向互传（阶段 1：管理员↔成员）。
不做：云盘、账号、文件夹同步、无外网局域网、纯邻近传输、跨会话续传。

## 快速验证

见上方命令。M0 交付后：

```bash
docker compose -f infra/docker-compose.yml up
pnpm -C apps/web dev   # 打开两个标签页互相传 10MB
```
