# CrossFile 设计系统 v0.1

> 配套：`01-design.md`（产品决策）、`02-protocol.md`、`03-roadmap.md`
> 实现文件：`design/tokens/tokens.css`（token）、`design/base.css`（组件）、`design/screens/`（设计稿）
> 验证脚本：`design/tools/check-contrast.mjs`（对比度）、`design/tools/shoot.sh`（出图）

---

## 1. 设计意图

CrossFile 是一个「工具」而不是「玩具」。用户在这一刻关心的是：**文件发出去没有、安不安全、对方收不收得到**。所有视觉决策必须服务这三件事。

1. **静** — 大面积留白与低饱和中性色，只有一个强调色（mint）。界面不抢注意力，文件与进度才是焦点。
2. **准** — 每个数字都可读：等宽数字、明确单位、路径标签、校验状态。不用「大概」「可能」糊弄。
3. **诚实** — 隐私承诺用短句直说，能力限制提前告知而不是失败后解释。视觉上不美化风险（警告用 amber，不用红色恐吓，也不用绿色掩盖）。
4. **一条信号线** — 品牌母题是一根线加一个点（sender → receiver）。它出现在品牌标记、分隔线、路径标签里，是「传输」这件事的视觉简写。

---

## 2. 视觉签名

| 元素 | 决策 |
|---|---|
| 主色 | **Mint**（OKLCH hue 168），高亮、技术感、不偏「环保绿」也不偏「黑客绿」；在明暗两种主题下都用亮 mint + 近黑文字，形成统一按钮签名 |
| 底色 | 浅色用冷白纸面（hue 258 中性），深色用深墨（不使用纯黑） |
| 品牌标记 | 26px 圆角方块：浅色=墨底 mint 图标，深色=mint 底墨图标（反相） |
| 分隔 | 1px hairline + 左端一个 5px mint 圆点（`.signal-rule`） |
| QR | 作为「加入」的主角，四周留白，不用花哨边框或渐变 |
| 插画/装饰 | 不用。没有渐变、没有玻璃拟态堆叠、没有 emoji 当图标 |

---

## 3. Token 三层模型

| 层 | 内容 | 文件/位置 |
|---|---|---|
| T1 原始值 | 颜色 ramp、间距、字号、圆角、动效曲线 | `tokens.css` `:root` 中 `--gray-* / --mint-* / --space-* / --text-*` |
| T2 语义 | `--bg-surface`、`--text-primary`、`--primary`、`--path-relay`… | `tokens.css` `[data-theme]` 块 |
| T3 组件 | 组件内使用的组合（按钮状态、输入状态、徽标状态） | `base.css` 各组件类 |

规则：**组件只允许引用 T2 语义 token**。T1 原始值只出现在 `tokens.css`。新增颜色先加 ramp，再加语义，不允许在组件里写 `oklch()` 或 `#hex`。

---

## 4. 色板（T1 原始值）

所有值以 OKLCH 定义，下表附 sRGB 近似值（便于与设计工具互通；实现以 OKLCH 为准）。

**中性色 ramp（hue 258，冷墨）**

| token | OKLCH | sRGB | 用途 |
|---|---|---|---|
| `--gray-0` | 99.2% 0.002 258 | `#fcfcfe` | 浅色卡片底、深色正文 |
| `--gray-25` | 97.8% 0.003 258 | `#f6f8fa` | 浅色页面底 |
| `--gray-50` | 95.5% 0.004 258 | `#eef0f3` | 浅色 inset |
| `--gray-100` | 93.0% 0.006 258 | `#e5e8ec` | 浅色 inset 深一档 |
| `--gray-200` | 88.5% 0.008 258 | `#d6d9de` | 浅色 hairline 边框 |
| `--gray-300` | 82.0% 0.010 258 | `#c0c4cb` | 深色次要文字 |
| `--gray-400` | 72.0% 0.012 258 | `#a0a5ac` | 深色 muted |
| `--gray-500` | 60.0% 0.012 258 | `#7c8188` | 输入/次要按钮边框（3:1+） |
| `--gray-600` | 48.0% 0.012 258 | `#595e65` | 浅色次要文字 |
| `--gray-700` | 38.0% 0.010 258 | `#3f4348` | 浅色三级文字 |
| `--gray-800` | 28.0% 0.009 258 | `#26292d` | 浅色正文 |
| `--gray-850` | 23.5% 0.008 258 | `#1c1e22` | 深色 elevated |
| `--gray-900` | 20.5% 0.007 258 | `#15171a` | 深色卡片 |
| `--gray-925` | 17.0% 0.006 258 | `#0e1012` | 深色页面 |
| `--gray-950` | 13.5% 0.005 258 | `#07080a` | 深色 inset、按钮上的文字 |

**Mint ramp（hue 168，主色）**

| token | OKLCH | sRGB | 用途 |
|---|---|---|---|
| `--mint-200` | 93% 0.055 168 | `#c5f4e1` | 浅色 soft 底 |
| `--mint-300` | 88% 0.100 168 | `#93edcb` | hover |
| `--mint-400` | 82% 0.130 168 | `#5fdfb4` | **主按钮 / 品牌** |
| `--mint-500` | 74% 0.150 168 | `#00c899` | active |
| `--mint-600` | 66% 0.150 168 | `#00ae80` | 深色描边 |
| `--mint-700` | 55% 0.130 168 | `#008963` | 浅色 path / 成功文字 |
| `--mint-800` | 42% 0.100 168 | `#005e42` | 浅色 soft 文字 |

**Amber（hue 75，警告/中继）**：`--amber-200 #f9eaca`、`300 #ffcf77`、`400 #f3b94c`、`600 #bb7400`、`700 #7f4a00`、`800 #613700`。
**Red（hue 25，危险）**：`--red-200 #ffdedb`、`300 #ff9e96`、`400 #fd736d`、`600 #c92f33`、`700 #a51e24`。
**Blue（hue 255，信息/直连路径）**：`--blue-200 #d7eaff`、`300 #9eceff`、`400 #65a7fa`、`500 #3280dd`、`600 #005fc6`。

---

## 5. 语义 token（T2）

| 意图 | Token | 浅色 | 深色 |
|---|---|---|---|
| 页面底 | `--bg-page` | gray-25 | gray-925 |
| 卡片底 | `--bg-surface` | gray-0 | gray-900 |
| 抬升面 | `--bg-elevated` | 白 | gray-850 |
| inset / 次级面 | `--bg-subtle` / `--bg-inset` | gray-50 / gray-100 | gray-850 / gray-950 |
| 正文 | `--text-primary` | gray-800 | gray-0 |
| 次要文字 | `--text-secondary` | gray-600 | gray-300 |
| 弱化文字 | `--text-muted` | gray-500 | gray-400 |
| 主按钮文字 | `--text-on-primary` | gray-950 | gray-950 |
| 装饰线 / 边框 / 强边框 | `--border-hairline` / `--border` / `--border-strong` | gray-200 / gray-300 / gray-500 | 18% / 34% / gray-500 |
| 主色 / hover / active | `--primary` / `-hover` / `-active` | mint-400 / 300 / 500 | mint-400 / 300 / 500 |
| 主色浅底 / 其上文字 | `--primary-soft` / `-soft-text` | 96.5% 0.035 / mint-800 | 28% 0.05 / mint-300 |
| 危险 | `--danger` / `--danger-soft` / `--danger-text` | red-600 / red-200 / red-600 | red-400 / 27% 0.05 / red-400 |
| 警告 | `--warning` / `-soft` / `-border` / `-text` | amber-600 / 96.5% 0.045 85 / 85% 0.10 80 / amber-700 | amber-400 / 27% 0.05 75 / 42% 0.09 75 / amber-400 |
| 信息 | `--info` / `-soft` / `-text` | blue-600 / blue-200 / blue-600 | blue-400 / 28% 0.05 255 / blue-300 |
| 路径：局域网 / 直连 / 中继 | `--path-lan` / `--path-direct` / `--path-relay` | mint-700 / blue-600 / amber-700 | mint-400 / blue-300 / amber-400 |
| 焦点环 | `--focus-ring` | blue-500 | mint-400 |
| QR 前景/背景 | `--qr-fg` / `--qr-bg` | gray-950 / 白 | gray-950 / gray-0 |
| 阴影 | `--shadow-1/2/3` | 冷墨低透明度 | 更深的黑 |

同时把 `color-scheme` 写进主题块；`prefers-color-scheme: dark` 且未显式设 `data-theme` 时自动切深色。

---

## 6. 对比度验证

`node design/tools/check-contrast.mjs` 对 24 组前景/背景组合做 WCAG 计算，全部通过（正文 ≥4.5:1，UI/边框 ≥3:1）：

| 场景 | 组合 | 比值 | 要求 |
|---|---|---|---|
| 浅色正文 / 页面 | gray-800 on gray-25 | 13.69 | 4.5 |
| 浅色次要 / 卡片 | gray-600 on gray-0 | 6.39 | 4.5 |
| 浅色弱化 / 卡片 | gray-500 on gray-0 | 3.86 | 3.0 |
| 浅色主按钮文字 | gray-950 on mint-400 | 12.10 | 4.5 |
| 浅色输入边框 | gray-500 on gray-25 | 3.70 | 3.0 |
| 浅色焦点环 | blue-500 on gray-25 | 3.74 | 3.0 |
| 浅色警告文字 | amber-700 on amber-soft | 5.02 | 4.5 |
| 深色正文 / 页面 | gray-0 on gray-925 | 18.69 | 4.5 |
| 深色次要 / 卡片 | gray-300 on gray-900 | 10.26 | 4.5 |
| 深色弱化 / 卡片 | gray-400 on gray-900 | 7.22 | 3.0 |
| 深色主按钮文字 | gray-950 on mint-400 | 12.10 | 4.5 |
| 深色输入边框 | gray-500 on gray-900 | 4.54 | 3.0 |
| 深色警告文字 | amber-400 on gray-900 | 10.13 | 4.5 |

修改任何色值后必须重跑脚本；失败即阻断合并。

---

## 7. 排版

**字体栈**（全部本地/系统字体，离线可用，`font-display: swap`）

```css
--font-sans: "Inter", "Noto Sans CJK SC", "HarmonyOS Sans SC", "PingFang SC",
             "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif;
--font-mono: "JetBrains Mono", "Noto Sans Mono CJK SC", ui-monospace, "SF Mono", Menlo, monospace;
```

**字号阶梯**（1.25 比例，全部 `rem`，正文 16px）

| 角色 | Token | 值 | 行高 | 字重 | 字距 |
|---|---|---|---|---|---|
| Display（页面主标题） | `--text-display` | 2.5rem / 40px | 1.1 | 650 | −0.025em |
| H1 | `--text-h1` | 2rem / 32px | 1.2 | 640 | −0.02em |
| H2 | `--text-h2` | 1.5rem / 24px | 1.2 | 600 | −0.015em |
| H3 | `--text-h3` | 1.25rem / 20px | 1.3 | 600 | −0.01em |
| Lead | — | 1.0625rem / 17px | 1.5 | 400 | — |
| Body | `--text-body` | 1rem / 16px | 1.55 | 400 | — |
| Small（UI/次要） | `--text-small` | 0.875rem / 14px | 1.45 | 400–600 | — |
| Micro（eyebrow） | `--text-micro` | 0.75rem / 12px | 1.2 | 650 | 0.08em |
| 房间码 | mono | 2rem–2.625rem | 1.0 | 600 | 0.16em |
| 进度数字 | mono/tnum | 1.5rem | 1.0 | 640 | −0.02em |

规则：
- 正文永远 ≥14px；12px 只用于「大写 + 加粗 + 字距」的 eyebrow 或元数据。
- 数字（大小、速度、百分比、倒计时）一律 `font-variant-numeric: tabular-nums`，避免跳动。
- CJK 与拉丁混排：不手工加空格；`text-wrap: pretty` 用于标题与短段落（Chrome/Safari 支持，降级无副作用）。
- 中文标题不加大写转换；英文 eyebrow 才 `uppercase`。
- 行长：正文 `max-width: 52–68ch`；移动端自动由容器约束。

---

## 8. 间距、网格与布局

**间距标尺（4pt 基数，8pt 节奏）**：`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96`（`--space-1…9`）。
组件内 padding 用 12/16；区块间距 24/32；页面级 32/48。

**页面容器**：桌面 `max-width: 1200px`（宽版 1360），左右 32px；移动端左右 20px，底部为固定操作条预留 152px。

**主布局（桌面）**：`room-grid = minmax(0,1fr) + 388px`，gap 24。左列放「要发的东西」（标题、拖拽区、文件清单），右列放「加入方式与接收方」（QR、链接、房间码、接收方列表）。这是 1-2 分钟可扫完的信息结构：**左=做什么，右=谁加入**。

**断点**：`≥1024` 双列；`960–1023` 单列但保留桌面密度；`<960` 单列、卡片内边距降到 16；`<640` 移动壳（底部固定操作条 + 安全区）。
（组件级宽度差异用容器查询处理：例如接收方卡片在侧栏 388px 与全宽 700px 下自动切换紧凑/宽松排布——v1 直接写两套密度类，验证后再引入 container query。）

**移动安全区**：底部 `padding-bottom: calc(16px + env(safe-area-inset-bottom))`；顶部标题区避开刘海。

---

## 9. 形态：圆角、描边、阴影

| 类型 | Token | 值 | 用途 |
|---|---|---|---|
| 圆角 | xs / sm / md / lg / xl / full | 6 / 8 / 12 / 16 / 24 / 999px | 徽标/小控件 / 小按钮 / 按钮/输入/卡片内元素 / 卡片 / 对话框 / 胶囊 |
| 描边 | hairline / border / strong | 1px | 卡片分隔 / 输入默认 / 输入与次要按钮（≥3:1） |
| 阴影 | shadow-1 / 2 / 3 | 1px 微影 / 12px 柔和 / 24px 浮层 | 卡片 / hover 抬升 / 对话框 |

深色主题不靠「更黑的阴影」区分层级，靠更高的 surface 亮度（gray-900 → 850）与 hairline。

---

## 10. 动效

| Token | 值 | 用途 |
|---|---|---|
| `--dur-fast` | 120ms | hover / focus / 按压 |
| `--dur-base` | 180ms | 状态切换、展开 |
| `--dur-slow` | 260ms | 进度条、面板出现 |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | 进入、位移 |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | 退出 |

规则：
- 只动 `transform` / `opacity` / `background-color` / `width`（进度条）；不动 `top/left/height` 做布局动画。
- 进度条是**诚实进度**：只在收到确认的分片/字节后前进，不预测、不回跳（除非服务端校验失败，此时明确显示「校验失败」）。
- 等待态用 2s 呼吸圆点（`.dot-live`），`prefers-reduced-motion` 下静止。
- 所有过渡在 `prefers-reduced-motion: reduce` 下归零。

---

## 11. 图标

- 图标系统：**Lucide**（ISC 许可），本地 SVG，`stroke-width: 1.9`，`currentColor`。
- 尺寸：行内 16px（`.icon--sm`）、默认 20px、强调 24px、完成态 32px。
- 清单：`send / file / file-text / file-video / laptop / smartphone / qr-code / link / copy / check / shield-check / lock / wifi / globe / radio-tower / upload / plus / arrow-right / x / clock / triangle-alert / pause / loader-circle`。
- 禁止用 emoji 充当 UI 图标。**唯一例外**：6 位码路径的安全码（SAS）按协议就是 4 个 emoji，这是功能而非装饰，界面上必须配文字说明「和对方屏幕上的一致吗？」。

---

## 12. 组件规范

所有交互组件必须实现完整状态：`default / hover / active / focus-visible / disabled / loading`。焦点环统一 `outline: 3px solid var(--focus-ring); outline-offset: 2px`（环与相邻背景的对比度已按 3:1 设计）。

### 12.1 Button

- 结构：`[可选 leading icon] label`；高度：md 44px（Web 默认）、sm 36px（桌面密集场景，**移动端不用**）、lg 52px（移动主操作）。
- 变体：`primary`（mint 底 + 深墨字）、`secondary`（卡片底 + 强边框）、`ghost`（透明 + 次要文字）、`danger`（透明 + 危险文字，hover 用 danger-soft；破坏性操作必须过确认对话框）。
- 状态：primary hover→mint-300、active→mint-500 且 `scale(.985)`；disabled→`bg-inset` + `text-muted` + `cursor: not-allowed`；loading→替换图标为 `loader-circle` 旋转 + `aria-busy="true"` + 保持宽度避免跳动。
- 触控目标 ≥44×44px；图标按钮 44×44px。

### 12.2 图标按钮（IconButton）

- 44×44，圆角 12，默认无底色，hover 用 `bg-subtle`；必须有 `aria-label`。

### 12.3 加入面板（JoinPanel）

- 结构：卡片 → 标题行（「扫码加入」+ 路径预期胶囊）→ QR 框（白底、16px 静区、最小 168px、附 `aria-label`）→ 链接行（可点复制、URL 省略号截断）→ 6 位码（等宽 2rem、字距 .16em、可复制）→ 安全说明（锁图标 + 一句）。
- 状态：正常 / 已过期（整卡降饱和 + 「已过期，点此重建」）/ 被关闭（禁用交互）。

### 12.4 接收方行（ReceiverRow）

- 结构：40px 圆形设备图标 + 名称（15px/570）+ 元信息（12px，浏览器/状态）+ 右侧「路径胶囊 / 状态胶囊 / 批准-拒绝按钮」。
- 状态：等待批准（warning 底 + warning 边框 + 批准/拒绝）、已加入（普通卡 + 路径胶囊）、传输中（名称下方 4px 迷你进度条 + 百分比）、已移除（降饱和 + 「已移除」）。
- 键盘：行内按钮可 Tab 到达；批准用 Enter，拒绝用 Esc 或明确按钮。

### 12.5 文件行（FileRow）

- 结构：44px 文件类型图标块 + 文件名（15px/570，单行省略，`title` 给全名）+ 元信息（大小 · 类型 · 状态）+ 右侧「发送给」胶囊组或状态胶囊。
- 胶囊为「文件 × 人」矩阵的最小表达：选中 = mint soft 底 + check 图标；未批准接收方 = 虚线边框 + disabled。
- 空状态：拖拽区 + 一句「还没有文件」+ 选择按钮。

### 12.6 进度（Progress）

- 结构：百分比（24px/640 tabular）+ 已传/总量 + 路径胶囊 + 10px 轨道 + 元信息（速率 / 剩余 / 已用）。
- 语义：`role="progressbar"` + `aria-valuemin/max/now` + `aria-label`；每秒最多更新 4 次 DOM，屏幕阅读器用 `aria-live` 每 10% 播报一次。
- 未知总量时用不确定态（shimmer），但 CrossFile 总是先拿到清单，所以只有「重连中」会短暂出现。

### 12.7 路径胶囊（PathBadge）

- 7px 圆点 + 12px/650 文字；`局域网`（mint）、`直连`（blue）、`中继`（amber）。
- **永远带文字**，不允许只靠颜色区分；给屏幕阅读器完整句子「当前走局域网直连」。

### 12.8 警告卡（WarningCard）

- 结构：24px 图标 + 标题（14px/650）+ 正文（14px）+ 可选链接。
- 只用于「可继续但有风险」（能力上限、中继降速）；不可恢复错误用内联错误 + 对话框。背景 amber-soft，边框 amber-border，文字 amber-text。
- 文案必须给「接下来怎么办」，不只说「有风险」。

### 12.9 对话框（Dialog）

- 宽 ≤480px，圆角 16，shadow-3，遮罩 `oklch(0% 0 0 / 0.45)`；焦点陷阱 + 打开前焦点记忆 + 关闭后恢复；Esc 关闭（破坏性确认除外，需显式选择）。
- 用于：接收方批准、结束房间确认、能力风险确认、校验失败。

### 12.10 固定操作条（StickyBar / Mobile Sticky）

- 桌面：底部吸附，左信息右操作，backdrop blur 12px，顶部 hairline。
- 移动：固定底部，一次只放一个主操作 + 一个次要操作（同一行），高度 52px，底部安全区留白；内容区预留 152px 防遮挡。

### 12.11 轻提示与播报（Toast / LiveRegion）

- 传输关键事件用页内 `role="status"` 文本（「已收到对方确认，第 1 个文件完成」），不用纯 toast 承担关键信息。
- toast 仅用于复制成功等瞬时反馈，5s 自动消失，可 Esc 关闭。

---

## 13. 可访问性

对照 WCAG 2.2 AA：

| 要求 | 实现 |
|---|---|
| 1.4.3 文本对比 | 24 组组合全部 ≥4.5:1（或 ≥3:1 的 UI 元素），脚本强制 |
| 1.4.11 非文本对比 | 输入框/次要按钮边框使用 gray-500（≥3:1）；焦点环 ≥3:1 |
| 1.4.12 文本间距 | 使用 rem 与行高 token，允许用户覆盖行距不破版 |
| 1.4.4 / 1.4.10 缩放与重排 | 不用固定高度容器装文本；200% 缩放下 room-grid 自动单列 |
| 2.1.1 键盘 | 全流程可键盘完成：Tab 顺序 = 视觉顺序；⌘/Ctrl+Enter 开始发送；Esc 结束房间（确认） |
| 2.4.7 焦点可见 | 统一 `:focus-visible` 3px 环，offset 2px |
| 2.5.5 目标尺寸 | 44×44（移动）/ ≥24×24（桌面最小）；密集列表行高 ≥56px |
| 3.3 错误识别 | 错误内联在字段/文件行旁，带具体原因与下一步 |
| 4.1.3 状态消息 | 传输进度、加入、完成用 `role="status"` / `aria-live="polite"`，节流播报 |
| 减少动效 | `prefers-reduced-motion` 全量兜底 |
| 屏幕阅读器 | 图标按钮有 `aria-label`；路径胶囊读完整句子；QR 有 `aria-label`；文件行读「文件名，大小，状态」 |

待办（进入开发后）：VoiceOver / NVDA 实机走查、iOS Dynamic Type 200% 截图、色盲模拟检查（重点：mint vs amber 路径标签，因已配文字，风险低）。

---

## 14. 平台适配

| 平台 | 关键点 |
|---|---|
| **Web 桌面** | 1200px 容器；悬停态可用；⌘/Ctrl 快捷键；滚动条出现时保持 32px 右侧留白 |
| **Web 移动（含鸿蒙 ArkWeb）** | 390px 基准；单列；底部固定操作条；不依赖 hover；触控目标 44px；`100dvh` 处理地址栏伸缩；识别 ArkWeb UA（`ArkWeb/`）走与 Chromium 相同的分支 |
| **Tauri 桌面（Win/macOS/Linux）** | 保留系统窗口边框与红绿灯/关闭按钮（v1 不自绘标题栏）；macOS 左侧给红绿灯留 72px、Windows 11 用 8px 系统圆角；提供原生菜单「房间 / 编辑 / 帮助」；关闭窗口前若正在传输则确认 |
| **Tauri iOS/Android** | 安全区 `env(safe-area-inset-*)`；分享面板接收文件；保存到「文件」/相册；前台服务保活时显示系统通知；返回手势不中断传输（后台继续，回来续上） |
| **鸿蒙 NEXT 浏览器** | 与 Web 移动一致；下载交给系统下载管理器（`WebDownloadDelegate`）；字体回退 `HarmonyOS Sans SC`；深色跟随系统 |
| **跨平台共享** | token 只维护一份 CSS；若将来需要原生 SwiftUI/Compose，从同一 token 表生成（见 `06` 参考），不各自手抄 |

中文排版补充：中文标题后不加句号；中英混排用 1 个空格；按钮文案 2–6 字；数字与中文之间留 1 个半角空格（「486.2 MB · 视频」）。

---

## 15. 文案与语气

**原则**：短句、动词开头、给下一步、不夸张、不卖萌、不承诺做不到的事。

| 场景 | 文案 |
|---|---|
| 隐私承诺（首页/页脚） | 服务器不存一个字节。密钥只在这张码里。 |
| 房间页主标题 | 把文件发给谁？ |
| 空状态（无接收方） | 还没有设备加入。让对方扫码，或把 6 位码发给他。 |
| 能力警告（iOS 大文件） | 这台 iPhone 接收 486 MB 风险较高。浏览器最多稳定保存约 100 MB。建议改用电脑接收，或安装 CrossFile App。 |
| 超大拒绝 | 超过对方浏览器能接收的上限。换成电脑接收，或让对方安装 App。 |
| 校验失败 | 校验没通过，文件可能损坏。已停止保存，请让对方重发一次。 |
| 房间结束 | 房间已结束，服务器没有留下任何副本。 |
| 续传中 | 连接中断，正在续传（还剩 138 MB）。 |
| 路径（中继） | 正在通过中继服务器传输，速度会慢一些。 |
| 结束房间确认 | 结束房间？正在传输的文件会中断，房间和密钥会立即销毁。 |

---

## 16. 设计到代码

- **唯一来源**：`design/tokens/tokens.css` → 应用通过 import 使用；`base.css` 是组件参考实现，开发时迁移为 React 组件但保持同名 token。
- **禁止硬编码**：组件内不得出现 `#hex`、`rgb()`、`hsl()`、裸 `oklch()`。CI 检查：`rg -n "#[0-9a-fA-F]{6}|oklch\(" apps packages --glob '!**/tokens.css'` 必须为零。
- **Tailwind 映射**（采用 Tailwind 时）：`theme.extend.colors: { bg: 'var(--bg-page)' … }`，间距与圆角同样映射到 CSS 变量；不新增 Tailwind 默认色板。
- **出图流程**：`node design/tools/build.mjs`（内联图标 + QR）→ `bash design/tools/shoot.sh`（Chrome headless 截图）→ 产物在 `design/screenshots/`。
- **变更流程**：改 token → 跑 `check-contrast` → 重出截图 → 更新本文件 §6 表格。

---

## 17. 设计稿索引

| # | 文件 | 画面 | 展示的设计点 |
|---|---|---|---|
| 01 | `design/screens/01-sender-room.html` | 桌面 · 浅色 · 发送方房间 | 双列信息结构、QR 为视觉主角、6 位码、文件 × 接收方矩阵、加入审批（警告底） |
| 02 | `design/screens/02-sender-transfer.html` | 桌面 · 深色 · 传输中 | 进度层级（62% 大数字 + 轨道）、路径胶囊、接收方状态、顺序队列、右侧详情 |
| 03 | `design/screens/03-mobile-receive.html` | 手机 · 浅色 · 接收方确认 | 能力风险警告（动态限制的界面表达）、文件级「偏大/可接收」、固定操作条 |
| 04 | `design/screens/04-mobile-done.html` | 手机 · 深色 · 接收完成 | 完成态、校验通过、传输回顾、零留存说明 |
| 05 | `design/screens/05-mobile-code.html` | 手机 · 浅色 · 发送方房间码 | 大号等宽码、二维码、等待态、已加入设备 |

截图：`design/screenshots/*.png`（桌面 1440×900，手机 390×844 @2x）。

---

## 18. 质量门

- [x] 间距在 4/8pt 系统上；组件无魔法数字
- [x] 层级可「眯眼」辨认：一个焦点（标题/进度），次级信息 0.75×
- [x] 颜色全部语义 token；浅/深两套都设计，24 组对比度自动验证通过
- [x] 字号全部 rem，正文 16px，最小文字 12px 仅用于加粗+字距的 eyebrow
- [x] 每个交互组件定义 default/hover/active/focus-visible/disabled（+ loading）
- [x] 键盘可走完全流程，焦点环 3px 且可见
- [x] 动效只用 transform/opacity/颜色，token 化，reduced-motion 兜底
- [x] 触控目标 ≥44px（移动）
- [x] 图标来自 Lucide，无 emoji 当图标（SAS 例外已说明）
- [x] 双主题截图均已出图并人工检查
- [ ] 屏幕阅读器实机走查（开发后）
- [ ] 真机 / Safari / 鸿蒙 ArkWeb 视觉回归（开发后）
- [ ] 色盲模拟检查与 Dynamic Type 200%（开发后）
