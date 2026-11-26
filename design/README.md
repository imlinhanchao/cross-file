# CrossFile 设计稿与设计系统

设计系统的完整说明（原则、token、组件、无障碍、平台适配、文案）在
[`../docs/04-design-system.md`](../docs/04-design-system.md)。本目录是可运行的实现与出图流水线。

## 目录

```
design/
├── tokens/tokens.css      # 唯一 token 来源（T1 primitives → T2 semantic，light/dark）
├── base.css               # 组件参考实现（按钮、卡片、QR、进度、警告卡、成员行、移动壳…）
├── src/screens/*.html     # 设计稿源文件（含 {{ICON:x}} / {{QR}} 占位符）
├── screens/*.html         # 构建产物：自包含、可离线直接打开
├── screenshots/*.png      # 出图（桌面 1440×900，手机 390×844 @2x）
├── assets/fonts/          # Inter + JetBrains Mono（latin 子集，本地托管）
├── assets/icons/          # Lucide 图标（本地 SVG）
├── assets/qr-room.svg     # 真实可扫的示例房间二维码
└── tools/
    ├── build.mjs          # 内联图标与二维码，生成 screens/
    ├── shoot.sh           # headless Chrome 截图
    ├── check-contrast.mjs # WCAG 对比度校验（33 组）
    └── make-qr.js         # 重新生成示例二维码
```

## 查看设计稿

直接打开 `screens/01-entry.html` 等文件即可（无需服务器，字体与图标已内联/本地）。

| # | 设计稿 | 画面 | 展示的设计点 |
|---|---|---|---|
| 01 | `screens/01-entry.html` | 桌面 · 浅色 · 首页 | 品牌 + 创建房间主按钮、6 位码 / 粘贴链接加入、隐私承诺与能力说明 |
| 02 | `screens/02-room-idle.html` | 桌面 · 浅色 · 房间内 | 统一 Room 页：邀请区仅管理员可见、成员列表（昵称/平台/状态/改名）、选文件 + 发送目标 |
| 03 | `screens/03-room-transfer.html` | 桌面 · 深色 · 双向传输中 | 两个方向同时传、同一对设备串行排队、三种路径标签 |
| 04 | `screens/04-mobile-incoming.html` | 手机 · 浅色 · 收到文件确认 | 每次接收都确认、能力风险警告卡、文件级「偏大/可接收」 |
| 05 | `screens/05-mobile-room.html` | 手机 · 浅色 · 房间内 | 成员列表 + 逐成员发送入口、改名；成员看不到邀请区 |
| 06 | `screens/06-mobile-done.html` | 手机 · 深色 · 完成 | SHA-256 校验通过、保存文件、可回到房间继续互传 |

## 重新出图

```bash
node design/tools/build.mjs            # 图标 + QR 内联
bash design/tools/shoot.sh             # 生成 design/screenshots/*.png
node design/tools/check-contrast.mjs   # 33 组对比度必须全部 PASS
```

## 规则

- 组件只允许引用语义 token（`--primary`、`--text-secondary`…），不允许 `#hex` 或裸 `oklch()`。
- 改颜色 → 先跑对比度脚本 → 再出图 → 更新 `docs/04-design-system.md` §6。
- 图标只用 `assets/icons/` 里的 Lucide 集合；缺图标先补下载，不要用 emoji 代替。
- 令牌若同步到原生壳（SwiftUI/Compose），从 `tokens.css` 的 T1 表生成，不手工抄写。

## 角色模型（v2）

v1 的「发送方 / 接收方」两页已合并为统一 Room 页：

- 房间里的每台设备都是**成员**，都能发也能收；创建房间的人是**管理员**，负责邀请、移除与结束房间。
- 成员显示名默认「平台 · 4 位代号」（如 `MacBook · 7K2F`），可改、可重名加后缀，仅本地记忆。
- 邀请区（二维码 / 链接 / 6 位码）只在管理员界面出现；成员界面不展示邀请入口。
- 传输按「同一对设备串行、不同成员可并发」设计，路径标签固定在传输行上。
