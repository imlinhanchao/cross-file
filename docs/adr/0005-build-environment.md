# ADR 0005 — 构建环境与依赖源

状态：已采纳（2026-11-24）

## 背景
本机 `cargo install tauri-cli` 因 crates.io 抖动失败；Tauri 壳构建同样依赖 crates.io；沙箱内 `~/.cargo` 只读。8787 端口被无关服务占用。

## 决定
- Tauri CLI 用 npm 版 `@tauri-apps/cli`（预编译，避免现编 CLI）。
- 本地构建脚本 `scripts/dev-env.sh` 导出 `CARGO_HTTP_TIMEOUT/LOW_SPEED_LIMIT/NET_RETRY`、Android/JDK 环境与仓库内 `CARGO_HOME`/`CARGO_TARGET_DIR` 约定；镜像配置属用户级，不提交。
- signaling 默认端口 8788；容器内仍 8787（compose 发布映射）。
- 根 `pnpm build` 只构建 Web；桌面用 `pnpm --filter @crossfile/desktop build`。

## 后果
- CI 不需要 Rust；桌面/移动构建是独立流水线。
