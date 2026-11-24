# ADR 0003 — 不引入 Tailwind

状态：已采纳（2026-11-24）

## 背景
设计系统 `design/tokens/tokens.css` + `design/base.css` 已是纯 CSS + OKLCH 语义 token；`docs/04` §16 规定组件只能引用语义 token，CI 杜绝 `#hex`/裸 `oklch()`。

## 决定
Web 直接复用 token 与组件类（`apps/web/src/styles` 引入 `design/`），不引入 Tailwind；新增样式只用语义 token。

## 后果
- 少一层映射与构建步骤，颜色门禁简单可靠。
- 组件样式集中在 `design/base.css` 与少量 app 级 glue；后续如需原子类再评估。
