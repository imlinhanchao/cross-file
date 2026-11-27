# CrossFile 桌面壳（Tauri 2）

> 工作包 WS9 / 验收 AC9。写域：`apps/desktop/**`、本文件。
> Web 代码不在这里，壳只做三件事：**原生写盘**、**关窗保护**、**原生菜单**。
> Web 前端通过 Tauri IPC 调用本文 §4 的命令；JS 侧接线由 Lead 负责（见 §4.3、§8.1）。

## 0. 目录与状态

```
apps/desktop/
├── package.json                 # name @crossfile/desktop，dev/build/check 脚本
├── src-tauri/
│   ├── Cargo.toml               # crossfile-desktop, tauri 2 + tauri-plugin-opener
│   ├── build.rs
│   ├── tauri.conf.json          # 1200×820 / min 960×640 / 系统边框 / dist 指向 apps/web/dist
│   ├── capabilities/default.json# core:default + opener:default，仅 main 窗口
│   ├── icons/                   # 占位图标（由 `tauri icon` 生成，可随时替换）
│   └── src/main.rs              # 保存句柄表、关窗保护、菜单
└── （Cargo.lock 一并提交）
```

2026-11-24 本机验证：`cargo check` 通过、`cargo test` 2/2 通过、`tauri build --no-bundle` 产出 release 可执行文件、`tauri dev` 成功创建窗口（详见 §7）。

## 1. 前置依赖

### 1.1 本机实测版本

| 组件                | 版本                     | 备注                                                                                                           |
| ------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Rust / cargo        | 1.90.0                   | `rustup` 安装的 stable-x86_64-unknown-linux-gnu                                                                |
| Node / pnpm         | 22.22.1 / 12.6.0         | 仓库要求 Node ≥ 22                                                                                             |
| WebKitGTK           | 2.52.6                   | `pkg-config --modversion webkit2gtk-4.1`                                                                       |
| GTK / libsoup / JSC | 3.24.41 / 3.4.4 / 2.52.6 | 编译期与运行期都需要                                                                                           |
| Tauri CLI           | 2.12.6（npm 版）         | 根 `devDependencies` 已有 `@tauri-apps/cli`，**不要** `cargo install tauri-cli`（本机 crates.io 抖动时失败过） |

### 1.2 Ubuntu / Debian 包（照抄可复现）

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  librsvg2-dev libssl-dev libxdo-dev
# 可选：无桌面环境时用虚拟 X 跑 dev/截图
sudo apt install -y xvfb
# 可选：托盘/指示器（当前壳未用托盘）
# sudo apt install -y libayatana-appindicator3-dev
```

自检：

```bash
pkg-config --modversion webkit2gtk-4.1 gtk+-3.0 libsoup-3.0 javascriptcoregtk-4.1
./node_modules/.bin/tauri info       # 应显示 webkit2gtk-4.1 ✔
```

> `tauri info` 会提示 `@tauri-apps/api not installed!` —— 这是预期：本壳用 `withGlobalTauri: true` 暴露 `window.__TAURI__`，前端不必装 npm 包（见 §4.3）。若要改用 `import { invoke } from "@tauri-apps/api/core"`，需要 Lead 在 `apps/web` 加依赖并跑 `pnpm install`。

## 2. 开发

```bash
# 终端 A：信令（若根 pnpm dev 已在跑，则 A/B 都已有）
pnpm dev:signal

# 终端 B：起 Web dev server（:5173）+ Tauri dev（自动起窗口）
pnpm --filter @crossfile/desktop dev

# 如果 Web dev server 已经单独在跑（例如根 pnpm dev），不要再让 Tauri 重复启动：
pnpm --filter @crossfile/desktop dev:attach
```

`dev:attach` 用 `apps/desktop/tauri.dev-attach.conf.json` 覆盖 `beforeDevCommand` 为空，其余配置不变。

- `build.devUrl = http://localhost:5173`：dev 下窗口直接加载 Vite，`/v1/ws` 由 Vite 代理到 `ws://127.0.0.1:8788`，与浏览器开发路径完全一致。
- `dev` 脚本经 `build.beforeDevCommand` 自动执行 `pnpm --filter @crossfile/web dev`；Vite 是 `strictPort: true`，**5173 被占用时该命令会失败**，此时改用 `dev:attach`。
- Rust 代码改动会触发 `cargo` 增量重编译并重启窗口；Web 代码走 Vite HMR。
- 调试：dev 构建默认带 devtools（窗口右键 → 检查元素，或 `Ctrl+Shift+I`）。
- **首次引入本包后需要在仓库根跑一次 `pnpm install`**：把 `@crossfile/desktop` 写进 `pnpm-lock.yaml` 的
  importers 并链接工作区包。本任务按约定没有执行 install（由 Lead 统一处理）；未 install 时
  `pnpm --filter @crossfile/desktop …` 仍能跑脚本（Tauri CLI 从根 `node_modules/.bin` 解析），但
  `pnpm install --frozen-lockfile` 会报 lockfile 过期，且可能在工作区根生成临时 `.pnpm-store/`。

### 2.1 统一 Room 页与路由（v2）

Web 端只有一个统一 Room 页（管理员与成员共用同一套界面）；桌面壳不做路由，只透传 Web：

| 路由 | 作用 |
|---|---|
| `/` | 首页入口：「创建房间」/「加入房间」 |
| `/room` | 直接创建房间（原生菜单「新建房间」的目标页） |
| `/r/<roomId>#<roomKey>` | 扫码 / 邀请链接加入 |
| `/j/<code>` | 输入 6 位房间码加入 |
| `/code` | 旧输码入口的别名（与 `/j/<code>` 等价，聚焦输码框） |
| `/privacy` | 隐私说明 |

- 原生菜单「新建房间」（Ctrl/Cmd+N）只 `emit("menu-action", "new-room")`；前端收到后导航到 `/room`
  创建新房间（若已在房间内，先结束或离开当前房间再进入）。
- 桌面壳没有自己的房间状态机；`CROSSFILE_URL`、`CROSSFILE_DEV_JOIN` 等深链直接指向上述任一地址即可。

## 3. 构建与打包

```bash
# 1) 先产出前端静态文件（tauri.conf 的 frontendDist = ../../web/dist）
pnpm --filter @crossfile/web build

# 2) 完整打包（web build + tauri build；产物在 src-tauri/target/release/bundle/）
pnpm --filter @crossfile/desktop build

# 只验证 Rust/壳能否产出可执行文件，不生成安装包（CI/无网络时用）
pnpm --filter @crossfile/desktop build:nobundle
# 等价：cd apps/desktop && ../../node_modules/.bin/tauri build --no-bundle
```

Linux 产物位置：

| 产物            | 路径                                                                                   |
| --------------- | -------------------------------------------------------------------------------------- |
| 可执行文件      | `apps/desktop/src-tauri/target/release/crossfile-desktop`                              |
| DEB             | `apps/desktop/src-tauri/target/release/bundle/deb/CrossFile_0.1.0_amd64.deb`           |
| RPM             | `apps/desktop/src-tauri/target/release/bundle/rpm/CrossFile-0.1.0-1.x86_64.rpm`        |
| AppImage        | `apps/desktop/src-tauri/target/release/bundle/appimage/CrossFile_0.1.0_amd64.AppImage` |
| macOS / Windows | 在对应系统上执行同一命令，产物在 `bundle/dmg\|macos\|msi\|nsis/`                       |

注意：

- `bundle.targets = "all"`。本机 `--no-bundle` 与 `--bundles deb` 均已验证；完整 AppImage 打包需要联网下载 linuxdeploy 工具链（GitHub），网络不稳时用 `tauri build --bundles deb`。
- 签名 / 公证 / 自动更新均未配置（见 §8）。
- 图标在 `src-tauri/icons/`，替换时准备 ≥1024×1024 PNG 后执行 `./node_modules/.bin/tauri icon <png>`。

## 4. 原生写盘命令（save sink / AC9）

### 4.1 命令签名

以下是 **JS 侧的调用契约**（`invoke` 的 cmd 名 + 参数）。Rust 函数还会自动注入 `AppHandle` 与 `State<AppState>`
两个参数（Tauri 机制），它们在 JS 侧不可见：

```rust
#[tauri::command] async fn save_open(name: String) -> Result<u64, String>;                        // 返回 handle id
#[tauri::command] async fn save_write(handle: u64, offset: u64, bytes: Vec<u8>) -> Result<(), String>; // 按偏移随机写
#[tauri::command] async fn save_close(handle: u64) -> Result<String, String>;                    // 返回最终路径
#[tauri::command] async fn save_abort(handle: u64) -> Result<(), String>;
```

行为：

| 命令         | 语义                                                                                                                  | 失败时                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `save_open`  | 在 `app.path().download_dir()` 下 `create_new` 目标文件并登记句柄表（`Mutex<HashMap<u64, File>>` 放在 Tauri `State`） | 下载目录不可用、磁盘/权限错误 → `Err("无法创建 …: …")` |
| `save_write` | `seek(offset)` + `write_all(bytes)`，允许乱序/重发（续传只补缺片）                                                    | 未知句柄、seek/写失败 → `Err`                          |
| `save_close` | 从表里移除、`sync_all()` 刷盘、返回最终绝对路径字符串（UI 展示用）                                                    | 未知句柄、刷盘失败 → `Err`                             |
| `save_abort` | 移除句柄、关闭文件并删除半成品文件（取消传输 / 哈希不符时）                                                           | 未知句柄 → `Err`；文件已不存在视为成功                 |

安全与命名：

- 文件名做**路径穿越清洗**：同时按 `/` 和 `\` 取最后一段，替换 `: * ? " < > |` 与控制字符，去掉首尾空白/点；空名或 `..` 落为 `crossfile-download.bin`。
- 目标文件永不覆盖：同名时依次尝试 `name (1).ext`、`name (2).ext`…（最多 10000 个）。
- 目录固定为系统「下载」目录；UI 拿到 `save_close` 的返回值后显示真实路径。

### 4.2 生命周期

```
save_open(name) ──► handle
       │
       ├─ save_write(handle, offset, chunk)   … 重复 N 次（可乱序/续传重发）
       │
       ├─ save_close(handle) ──► "/home/user/Downloads/xxx.bin"   （成功）
       └─ save_abort(handle)                                     （取消/校验失败）
```

- 句柄只能被 `save_close`/`save_abort` 消费一次；之后再用报「未知的保存句柄」。
- 进程退出时句柄表随进程释放；半成品文件保留（浏览器下载同款行为）。

### 4.3 JS 侧调用示例（Lead 接线用）

本壳 `tauri.conf.json` 开了 `app.withGlobalTauri: true`，无需 npm 依赖即可调用：

```ts
// apps/web 里建议先做壳探测，再设置 core 的 nativeShell 开关
const isTauri = "__TAURI_INTERNALS__" in window;
if (isTauri) (window as any).__CROSSFILE_NATIVE__ = true; // capability.detectCaps 会读取

const invoke = (window as any).__TAURI__.core.invoke as <T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

// 接收端保存一个文件：Tauri 2 的 IPC 是 JSON，Vec<u8> 用数字数组（不要直接传 Uint8Array）
const handle = await invoke<number>("save_open", { name: file.name });
for (const chunk of chunks) {
  await invoke("save_write", { handle, offset, bytes: Array.from(chunk) });
}
const savedPath = await invoke<string>("save_close", { handle });
// 失败/取消：await invoke("save_abort", { handle });
```

要点：

- Rust 参数是 snake_case，但 Tauri 2 的 JS 参数按 **camelCase** 映射；本文命令参数都是单词，直接写 `name / handle / offset / bytes` 即可。
- `offset` 是 `u64`，JS number 在 `2^53` 内安全（500MB 远小于该值）。
- 建议分片 256KB～1MB 一次 `save_write`；`Array.from` 的 JSON 编码有开销，但 500MB 总量可接受。若 Lead 需要更快的原始字节通道，可改用 Tauri 2 的 raw request / `Channel`（需另加 Rust 命令，不在本次接口内）。
- 若改用 `@tauri-apps/api`：`import { invoke } from "@tauri-apps/api/core"`，参数与返回值完全一致。

## 5. 传输中关窗保护

状态：`AppState.transfer_active: AtomicBool`。流程：

```
Web: 传输开始 ── invoke set_transfer_active({ active: true })
用户点关闭 / Ctrl+Q / 菜单「退出」 ── CloseRequested
        │
        ├─ transfer_active == false → 正常关闭
        └─ transfer_active == true  → api.prevent_close()
                                     → emit("close-requested")   （无 payload）
Web: 收到 close-requested → 弹自己的确认框
        ├─ 用户取消        → 什么都不做（窗口保持）
        └─ 用户确认关闭    → invoke("confirm_close") → app.exit(0)
Web: 传输结束/取消 ── invoke set_transfer_active({ active: false })
```

- 事件名固定 **`close-requested`**；前端用 `listen("close-requested", …)`（`window.__TAURI__.event.listen`）。
- 菜单「房间 → 退出 CrossFile」走同一判断：传输中只发 `close-requested`，不直接退出。
- `confirm_close` 会先把 `transfer_active` 置 false 再 `app.exit(0)`，所以不会二次拦截。
- Web 必须在每次传输开始/结束时准确调用 `set_transfer_active`；漏掉开始会让关窗无保护，漏掉结束会让用户无法正常关窗（只能 `confirm_close` 救场）。

## 6. 原生菜单

| 菜单  | 菜单项                                  | 行为                                                                                                          |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 房间  | 新建房间（Ctrl/Cmd+N）                  | 向前端 `emit("menu-action", "new-room")`；前端导航到 `/room` 创建新房间                                      |
| 房间  | 结束房间（Ctrl/Cmd+Shift+E）            | 向前端 `emit("menu-action", "end-room")`                                                                      |
| 房间  | 退出 CrossFile（Ctrl/Cmd+Q）            | 关窗保护流程（§5），非传输中直接 `app.exit(0)`                                                                |
| 编辑  | 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 | 系统预定义项（输入框可用）                                                                                    |
| 帮助  | 隐私说明                                | 用 `tauri-plugin-opener` 在系统浏览器打开 `https://room.net.time-pack.com/privacy`（即 Web 的 `/privacy` 页） |
| 帮助  | 项目主页                                | 打开 `https://room.net.time-pack.com/`                                                                        |
| macOS | CrossFile（关于 / 隐藏）                | 仅 macOS 追加，符合系统习惯                                                                                   |

- 两个外链可用环境变量覆盖：`CROSSFILE_PRIVACY_URL`、`CROSSFILE_HOMEPAGE_URL`（启动时读取）。
- 菜单里「新建/结束房间」只发事件，不在 Rust 侧重写房间状态机；前端 `listen("menu-action", e => …)` 处理，未接线时点击无效果。

## 7. 本机验证记录（2026-11-24）

| 项           | 命令                                              | 结论                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust 编译    | `cd apps/desktop/src-tauri && cargo check`        | ✅ `Finished dev profile [unoptimized + debuginfo] target(s) in 1m 33s`，0 warning                                                                                                                                                                      |
| 单元测试     | `cargo test`                                      | ✅ 2 passed（路径穿越清洗、同名去重），`Finished test profile … in 1m 45s`                                                                                                                                                                              |
| 前端产物     | `pnpm --filter @crossfile/web build`              | ✅ `dist/index.html` + assets 生成（228 modules，2.78s）                                                                                                                                                                                                |
| release 构建 | `pnpm --filter @crossfile/desktop build:nobundle` | ✅ `Finished release profile [optimized] target(s) in 3m 19s`；`Built application at: …/src-tauri/target/release/crossfile-desktop`（5.47 MB，stripped）                                                                                                |
| DEB 打包     | `tauri build --bundles deb`                       | ✅ `Bundling CrossFile_0.1.0_amd64.deb` → `…/bundle/deb/CrossFile_0.1.0_amd64.deb`（2.49 MiB）；AppImage 需联网，未在此环境验证                                                                                                                         |
| dev 窗口     | `pnpm --filter @crossfile/desktop dev:attach`     | ✅ 窗口创建并映射：Wayland 协议日志里 `xdg_toplevel.set_title("CrossFile")`、`set_app_id("crossfile-desktop")`、`xdg_toplevel.configure(1200, 857, …)`（857 = 820 内容 + 37 GTK 标题栏）；无 panic                                                      |
| IPC 端到端   | 临时 dev 页面（`devUrl` 指向静态页）调用命令      | ✅ `save_open` 把 `../../evil.bin` 清洗成 `Downloads/evil.bin`（handle=1）；两次 `save_write`（offset 0 与 14）后 `save_close` 返回绝对路径，文件内容 `hello from ipc!`；`set_transfer_active` 正常；`confirm_close` 后进程退出（tauri dev 4 秒内结束） |
| 截图         | GNOME Shell / portal                              | ⚠️ 未产出：沙箱内 `org.gnome.Shell.Screenshot` 返回 `AccessDenied: ScreenshotArea is not allowed`，本机没有 `gnome-screenshot` / `xvfb-run` / ImageMagick。窗口证据用 Wayland 协议日志与进程存活代替                                                    |

> 构建环境备注（只与本机 agent 沙箱有关）：
>
> 1. 沙箱把 `~/.cargo` 设为只读，`cargo check` 报 `failed to write cache … Read-only file system`。把 cargo 缓存复制到仓库内可写目录并以
>    `CARGO_HOME=/home/hancel/project/cross-file/.cache/cargo-home` 运行即可；**普通开发机不需要这一步**。
>    `.cache/` 已在根 `.gitignore` 中，未提交任何镜像配置。
> 2. 沙箱把 `~/.config`、`~/.cache`、`/run/user/1000` 设为只读时，Tauri/WebKit 启动会 panic：
>    `Failed to setup app: 只读文件系统 (os error 30)`。把 `HOME`/`XDG_*` 指到可写目录后窗口正常创建（`RUSTUP_HOME`
>    要保留原值，否则 rustup 找不到 toolchain）。普通桌面会话无需这些变量。

复现（无桌面环境）：

```bash
sudo apt install -y xvfb
xvfb-run -a pnpm --filter @crossfile/desktop dev:attach   # 5 秒后 Ctrl-C
```

## 8. 已知限制 / 待接线

1. **信令地址（已接线）**：壳提供 `get_shell_config` 命令，返回 `signaling_url`
   （`CROSSFILE_SIGNALING_URL` 覆盖，默认 `ws://127.0.0.1:8788/v1/ws`）；Web 侧
   `resolveSignalingUrl()` 在原生壳无注入/存储配置时向壳索取后再建连。
   实测 macOS 100 MB / 500 MB 均通过（落盘 sha256 与发送端一致）。
2. **`__CROSSFILE_NATIVE__` 需 JS 侧设置**（§4.3）；不设置则能力包仍按浏览器算，不会走 `native` 保存策略，500MB 限制也会按浏览器阈值判定。
3. **无代码签名 / 公证**；Linux 上双击 AppImage 可能需要 `chmod +x` 并信任。
4. **无自动更新**（未接 `tauri-plugin-updater`）。
5. **未做单实例**（`tauri-plugin-single-instance`）：多开会各自独立。
6. **CSP 为 null**（`app.security.csp`）：与 Web 现状一致；正式发布前建议按实际信令/TURN 域名收紧。
7. **原生文件拖放关闭**（`dragDropEnabled: false`）：保证 Web 的 HTML5 拖拽/选择文件在壳内照常工作；后续若要做「拖到窗口即发送」，需改回原生拖放并接 Tauri drag-drop 事件。
8. **菜单「新建/结束房间」未接线**：只发事件，JS 消费后才有行为（`new-room` → 导航到 `/room`；
   `end-room` → 结束当前房间）。
9. 只在 Linux 验证；macOS/Windows 需在对应系统复跑 `cargo check` / `tauri build`（配置文件已按跨平台写）。
10. `save_write` 走 JSON IPC（数字数组），大文件比二进制通道多一层编码开销；AC9 的 500MB 用例需实测吞吐后决定是否加 raw 通道。
11. **工作区接入（Lead 处理）**：新增 `@crossfile/desktop` 后根 `pnpm-lock.yaml` 还没有该 importer；请在根跑一次
    `pnpm install` 更新锁文件。注意根 `pnpm build`（`pnpm -r build`）从此会包含桌面壳构建（先 `@crossfile/web build`
    再 `tauri build`），纯 Web CI 请显式 `pnpm --filter @crossfile/web build`，或给桌面壳加 CI 开关。
12. `pnpm typecheck` / `pnpm test` 不受影响：桌面壳没有 `typecheck` 脚本，`vitest` 只收集 `*.test.ts`。

## 9. 故障排查

| 现象                                                         | 处理                                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo check` 报 webkit2gtk / soup3 `pkg-config` 找不到      | 装 §1.2 的 `-dev` 包；`pkg-config --modversion webkit2gtk-4.1` 应成功                                                                                                      |
| 窗口白屏（Wayland / 虚拟机）                                 | 试 `WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm --filter @crossfile/desktop dev:attach`                                                                                          |
| `dev` 起不来，Vite 报 `Port 5173 is already in use`          | Web dev server 已在跑，改用 `dev:attach`                                                                                                                                   |
| `tauri build` 卡在 AppImage 下载                             | 用 `--bundles deb` 或 `build:nobundle`                                                                                                                                     |
| 关窗被拦但没有弹窗                                           | 前端未 `listen("close-requested")` 或未调 `confirm_close`；传输状态没复位也会一直拦                                                                                        |
| `tauri info` 提示缺 `@tauri-apps/api`                        | 预期行为，见 §1.2 末注                                                                                                                                                     |
| `save_open` 返回「无法定位下载目录: unknown path」           | Linux 精简环境没有 xdg-user-dirs 配置；`download_dir()` 依赖 `~/.config/user-dirs.dirs` 里的 `XDG_DOWNLOAD_DIR`（GNOME 桌面默认有）。装上 `xdg-user-dirs` 或补一行配置即可 |
| 启动 panic `Failed to setup app: 只读文件系统 (os error 30)` | HOME/XDG 目录不可写（受限容器/沙箱）；把 `HOME`、`XDG_*` 指到可写目录（`RUSTUP_HOME` 保留原值）                                                                            |
| 工作区根多出 `.pnpm-store/`                                  | 新增包尚未 `pnpm install` 时 pnpm 的临时行为；根目录跑一次 `pnpm install` 后删除该目录                                                                                     |

---

## 5. Linux 限制：发行版 WebKitGTK 不含 WebRTC（重要）

Ubuntu 24.04 的 `webkit2gtk-4.1` 构建默认关闭 WebRTC，所以 **Linux 桌面壳里
`RTCPeerConnection` 是 undefined**（页面能加载、IPC/写盘可用，但无法建立 P2P 连接）。
已在 webview 内取证（debug 诊断通道报 `ReferenceError: Can't find variable: RTCPeerConnection`）。

- Web 端已加诚实预检：检测不到 WebRTC 时显示「当前环境不支持 WebRTC」，不建房、不握手；
- Linux 用户请用 Chrome/Edge/Safari 打开自托管单源地址（`http://<host>:8788`），或使用 Windows/macOS 桌面壳；
- 细节与后续可选项见 `docs/adr/0008-linux-webkitgtk-without-webrtc.md`。

### 5.1 Linux 可用方案：Electron 壳（ADR 0009）

`apps/desktop-electron/` 用 Electron（自带 Chromium，含 WebRTC）作为 Linux 桌面壳；preload 暴露与 Tauri
相同的 `__TAURI__` 桥，所以 Web 代码无需分支。IPC 与本文 §4 命令完全一致，保存目录为系统「下载」目录。

```bash
# 作为接收端（示例：带开发钩子的房间链接）
CROSSFILE_URL='http://127.0.0.1:5173/r/<id>?debug=1&autoaccept=1#<key>' \
  HOME=$PWD/.cache/app-home ./node_modules/.bin/electron apps/desktop-electron --no-sandbox

# 正常使用：指向自托管单源地址
CROSSFILE_URL='http://127.0.0.1:8788' ./node_modules/.bin/electron apps/desktop-electron
```

实测：100 MB 与 **500 MB** 均通过，落盘文件 sha256 与发送端一致（AC9 Linux 侧）。

打包 Linux 安装包（AppImage）：

```bash
cd apps/desktop-electron
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
pnpm --filter @crossfile/desktop-electron exec electron-builder --linux AppImage --config electron-builder.yml
# 产物：apps/desktop-electron/dist-electron/CrossFile-0.1.0-x86_64.AppImage（约 120 MB）
```

已验证：构建成功、`--appimage-extract` 可解出 `app.asar` 与启动器；并**用解包后的 AppImage 实跑接收 100 MB**：
路径「局域网直连」，发送端上报 `HASH MATCHES EXPECTED: true`（sha256 `4feb8ba7…`），落盘文件 104 857 600 B、
sha256 完全一致，同名文件自动去重为 `ac4-100mb (1).bin`。
注意：AppImage 运行需要 FUSE（或 `--appimage-extract-and-run`）；当前未设置自定义图标（Electron 默认图标），
需要品牌图标时放 `build/icon.png`（512×512）再打包。

## 6. 自动化验收钩子（debug-only）

`src/main.rs` 里有一个用 `#[cfg(debug_assertions)]` 包起来的导航钩子：设置环境变量
`CROSSFILE_DEV_JOIN=<房间链接>` 后，应用启动约 2.5 s 会 `eval` 跳转到该链接，配合 dev server 的
`?autoaccept=1` 即可在无人点击的情况下跑完「接收 → 原生写盘」。release 构建不包含这段代码。

```bash
cd apps/desktop
CROSSFILE_DEV_JOIN='https://room.net.time-pack.com/r/<id>?autoaccept=1#<key>' \
  pnpm tauri dev --config tauri.dev-attach.conf.json
```

agent 沙箱内窗口无法创建（MESA/ZINK + Wayland socket 受限），这条路径需要在真实桌面会话里跑。

## 7. Web 侧集成（Lead 已接线，2026-11-24）

- 能力包：`apps/web/src/lib/native.ts` 在 React 挂载前检查 `__TAURI_INTERNALS__` 并设 `window.__CROSSFILE_NATIVE__ = true`，`detectCaps()` 因此上报 `nativeShell: true` / `saveStrategies: ["native","blob"]`。
- 保存：`createNativeSink()` 把每片明文按 offset 调 `save_write`，`save_close` 返回路径；接收完成页展示「已保存到 …」，不再生成内存 Blob。
- 关窗：`installNativeShellHooks()` 监听 `close-requested`，传输中弹确认（取消则窗口保持），确认后 `confirm_close`。
- 菜单：`menu-action` 的 `new-room` / `end-room` 已接到 Web 控制器。
- 传输标志：开始/结束/暂停时调用 `set_transfer_active`，与 Rust 的 `AtomicBool` 对应。
- 信令地址：解析顺序 `window.__CROSSFILE_SIGNALING_URL__` → `localStorage["crossfile.signalingUrl"]` → 桌面默认 `ws://127.0.0.1:8788/v1/ws` → 同源。自托管实例可先写 localStorage 过渡，正式设置页属 M4。
- 根脚本：`pnpm build` 只构建 Web；桌面用 `pnpm --filter @crossfile/desktop build`（或 `build:nobundle`）。

## 发布产物与默认实例

GitHub Releases 提供桌面安装包（见 `docs/release.md`）：Linux `CrossFile-<version>-x86_64.AppImage`（Electron）、
Windows `CrossFile_<version>_x64_en-US.msi` / `-setup.exe`（Tauri，未签名）、macOS `CrossFile_<version>_universal.dmg`
（Tauri universal，未签名/未公证）。桌面壳默认连接官方实例 `https://file.time-pack.com`；自托管可用
`CROSSFILE_URL`（Electron）或应用内设置/菜单（Tauri）覆盖。
