# CrossFile（暂定代号）

> 临时大文件、扫码即传、端到端加密、服务器不存一个字节。
> 跨平台：Web（零安装接收）/ 桌面（Tauri）/ 手机（Tauri）/ 鸿蒙（浏览器）。

**当前状态：M0 已跑通（2026-11-24）。** 两个浏览器经本机信令 + WebRTC 数据通道互传 10 MB / 100 MB / 500 MB，密文分片 AES-256-GCM、全文件 SHA-256 双向校验一致，界面显示真实路径标签（局域网直连 / 直连 / 中继）。设计与验收细节见 [docs/05-development-plan.md](docs/05-development-plan.md)。

```bash
pnpm install
pnpm dev:signal            # 信令：ws://127.0.0.1:8788/v1/ws（零存储、无数据库）
pnpm dev:web               # Web：http://127.0.0.1:5173
pnpm gate                  # typecheck + 单测 + 对比度 24/24 + 零硬编码色值
pnpm e2e                   # Playwright 双浏览器真实传输（默认 10 MB）
E2E_FILE_MB=500 pnpm e2e   # 500 MB 用例
```
开发期 HTTPS 由既有反代提供：`https://room.net.time-pack.com` → `127.0.0.1:5173`（`allowedHosts` 已开，`/v1/ws` 走 Vite 代理）。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/01-design.md](docs/01-design.md) | 产品定位、非目标、18 条已定决策、动态能力限制、隐私承诺、验收标准 |
| [docs/02-protocol.md](docs/02-protocol.md) | 信令协议、密钥与加密、分片帧格式、续传状态机、ICE 路径、零存储约束 |
| [docs/03-roadmap.md](docs/03-roadmap.md) | 仓库结构、技术栈、M0–M4 里程碑、测试矩阵、风险清单 |
| [docs/04-design-system.md](docs/04-design-system.md) | 设计系统：设计意图、OKLCH token、排版、组件与状态、无障碍、平台适配、文案 |
| [design/](design/README.md) | 设计稿与出图流水线：5 个画面、token、对比度校验、截图脚本 |
| [docs/FACT-SHEET-web-large-file-transfer.md](docs/FACT-SHEET-web-large-file-transfer.md) | 附录 A：浏览器/平台能力的实测事实（Chrome 157、Safari 27） |
| [docs/prior-art-ephemeral-file-sharing.md](docs/prior-art-ephemeral-file-sharing.md) | 附录 B：14 个竞品的拓扑、存储、上限、许可、活跃度 |
| [docs/FACT-SHEET-safari-harmonyos.md](docs/FACT-SHEET-safari-harmonyos.md) | 附录 C：Safari 流式保存、鸿蒙 ArkWeb 内核版本、本机鸿蒙模拟器 |

## 一句话边界

做：同步、点对点、零服务器存储、500MB 级、一次性传输。
不做：云盘、账号、文件夹同步、无外网局域网、纯邻近传输、跨会话续传。

## 快速验证

见上方命令。M0 交付后：

```bash
docker compose -f infra/docker-compose.yml up
pnpm -C apps/web dev   # 打开两个标签页互相传 10MB
```
