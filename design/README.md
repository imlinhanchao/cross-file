# CrossFile 设计稿与设计系统

设计系统的完整说明（原则、token、组件、无障碍、平台适配、文案）在
[`../docs/04-design-system.md`](../docs/04-design-system.md)。本目录是可运行的实现与出图流水线。

## 目录

```
design/
├── tokens/tokens.css      # 唯一 token 来源（T1 primitives → T2 semantic，light/dark）
├── base.css               # 组件参考实现（按钮、卡片、QR、进度、警告卡、移动壳…）
├── src/screens/*.html     # 设计稿源文件（含 {{ICON:x}} / {{QR}} 占位符）
├── screens/*.html         # 构建产物：自包含、可离线直接打开
├── screenshots/*.png      # 出图（桌面 1440×900，手机 390×844 @2x）
├── assets/fonts/          # Inter + JetBrains Mono（latin 子集，本地托管）
├── assets/icons/          # Lucide 图标（本地 SVG）
├── assets/qr-room.svg     # 真实可扫的示例房间二维码
└── tools/
    ├── build.mjs          # 内联图标与二维码，生成 screens/
    ├── shoot.sh           # headless Chrome 截图
    ├── check-contrast.mjs # WCAG 对比度校验（24 组）
    └── make-qr.js         # 重新生成示例二维码
```

## 查看设计稿

直接打开 `screens/01-sender-room.html` 等文件即可（无需服务器，字体与图标已内联/本地）。

| # | 设计稿 | 画面 |
|---|---|---|
| 01 | `screens/01-sender-room.html` | 桌面 · 浅色 · 发送方房间 |
| 02 | `screens/02-sender-transfer.html` | 桌面 · 深色 · 传输中 |
| 03 | `screens/03-mobile-receive.html` | 手机 · 浅色 · 接收方确认（能力风险） |
| 04 | `screens/04-mobile-done.html` | 手机 · 深色 · 接收完成 |
| 05 | `screens/05-mobile-code.html` | 手机 · 浅色 · 发送方房间码 |

## 重新出图

```bash
node design/tools/build.mjs     # 图标 + QR 内联
bash design/tools/shoot.sh      # 生成 design/screenshots/*.png
node design/tools/check-contrast.mjs   # 24 组对比度必须全部 PASS
```

## 规则

- 组件只允许引用语义 token（`--primary`、`--text-secondary`…），不允许 `#hex` 或裸 `oklch()`。
- 改颜色 → 先跑对比度脚本 → 再出图 → 更新 `docs/04-design-system.md` §6。
- 图标只用 `assets/icons/` 里的 Lucide 集合；缺图标先补下载，不要用 emoji 代替。
- 令牌若同步到原生壳（SwiftUI/Compose），从 `tokens.css` 的 T1 表生成，不手工抄写。
