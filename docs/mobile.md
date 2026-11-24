# CrossFile 手机壳（Tauri 2，Android / iOS）

> 工作包 WS10 / 验收 AC9（手机壳）。写域：`apps/mobile/**`、本文件。
> 目标：复用 Web 的全部传输逻辑，壳只做四件事：**原生写盘**、**传输保活**、**分享接收（可选）**、**返回手势不中断**。
> JS 侧通过 Tauri IPC 调用与桌面壳**完全相同**的命令名与参数（`docs/desktop.md` §4），Web 代码无需为手机另写分支。

状态（2026-11-24，本机 Linux）：Rust 侧 `cargo check --target aarch64-linux-android` ✅、单元测试 3/3 ✅、
`tauri android init` ✅、debug APK 产出 ✅（116 MB，`com.crossfile.mobile`，arm64-v8a）。
**端到端（模拟器安装/启动/500MB 实跑）未验证**，原因见 §8、§9：本机没有 `/dev/kvm`，`tauri android build` 在
agent 沙箱内被 inotify 限制阻断（等价 Gradle 流程已成功）。iOS 完全未构建（无 macOS/Xcode）。

## 0. 目录与状态

```
apps/mobile/
├── package.json                      # name @crossfile/mobile，脚本见 §2
├── android-extras/
│   ├── apply.sh                      # 把 §4/§5/§6 的 Android 补丁写入 gen/android（幂等）
│   └── kotlin/
│       ├── MainActivity.kt           # 前台服务启动/停止、返回手势、ACTION_SEND 入口
│       ├── KeepAliveService.kt       # dataSync 前台服务（保活）
│       └── ShareIntake.kt            # ACTION_SEND 文件接收骨架（未接 JS）
└── src-tauri/
    ├── Cargo.toml                    # crossfile-mobile；[lib] staticlib/cdylib/rlib（移动端入口）
    ├── build.rs
    ├── tauri.conf.json               # identifier com.crossfile.mobile；frontendDist ../../web/dist
    ├── tauri                        # Gradle 桥接 shim：`node tauri …` → 工作区 Tauri CLI（§2.3）
    ├── capabilities/default.json     # core:default，仅 main 窗口
    ├── icons/                        # 占位图标（复制自桌面壳，可随时替换）
    ├── src/lib.rs                    # 保存句柄表、保活、壳全局注入、命令注册
    ├── src/main.rs                   # 桌面 shim（`cargo run` 用；Android 走 lib 的 mobile_entry_point）
    └── gen/
        ├── schemas/                  # tauri-build 生成的 ACL schema
        └── android/                  # `tauri android init` 生成的 Android Studio 工程（已加壳补丁）
```

`gen/android/` 是 `tauri android init` 生成的，可以入库；`app/build/`、`jniLibs/`、`app/src/main/java/**/generated/`、
`tauri.settings.gradle` 等每次构建重新生成，已被 `apps/mobile/.gitignore` 忽略。若重新生成整个 Android 工程，
再跑一次 `bash android-extras/apply.sh` 恢复壳补丁。

## 1. 前置依赖与环境

### 1.1 本机实测版本

| 组件          | 版本 / 路径                                                                    | 备注                                                        |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Rust          | 1.90.0（rustup stable-x86_64-unknown-linux-gnu）                               | 需要 4 个 Android target，见 §1.2                           |
| JDK           | 21.0.13.1（`/home/hancel/jdk-21`）                                             | **必须是有 `javac` 的 JDK**，见 §1.3                        |
| Android SDK   | `~/Android/Sdk`（build-tools 35/36，platforms 33–37.0）                        | `compileSdk/targetSdk = 37`，`minSdk = 24`                  |
| NDK           | 28.2.13676358                                                                  | `NDK_HOME` 指向 `$ANDROID_HOME/ndk/<ver>`                   |
| Gradle        | 9.6.1（`gen/android/gradlew` 自带 wrapper）                                    | AGP 9.3.1、Kotlin 2.2.10（模板生成，不要手改版本）          |
| AVD           | `Medium_Phone_API_37.0`（x86_64, google_apis_playstore）                       | 本机无 KVM，起不来（§8）                                    |
| Tauri CLI     | 2.12.6（npm 版，`./node_modules/.bin/tauri`）                                  | 不要 `cargo install tauri-cli`                              |
| Node / pnpm   | 22.22.1 / 12.6.0                                                               | 仓库要求 Node ≥ 22                                          |

`source scripts/dev-env.sh` 会导出 `ANDROID_HOME`、`ANDROID_SDK_ROOT`、`NDK_HOME`（最新 NDK）、`JAVA_HOME`、`PATH`。

### 1.2 rustup Android target

`tauri android init` 会自动安装（本机已验证 4 个都装好）：

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
# 等价：cd apps/mobile && ../../node_modules/.bin/tauri android init   # 会自动补 target
```

- 真机 / 默认 APK：`aarch64-linux-android`
- x86_64 模拟器：`x86_64-linux-android`
- 老设备 / 兼容包：`armv7-linux-androideabi`、`i686-linux-android`（只有做 universal APK 时才需要）

### 1.3 JDK：`dev-env.sh` 在本机指向的是 **JRE**（重要）

`scripts/dev-env.sh` 把 `JAVA_HOME` 设成 `/usr/lib/jvm/java-21-openjdk-amd64`，本机该目录**只有 JRE，没有 `javac`**：

```
$ /usr/lib/jvm/java-21-openjdk-amd64/bin/javac -version
bash: .../bin/javac: No such file or directory
```

Gradle 9 的 toolchain 检查会直接失败：

```
> Failed to calculate the value of task ':buildSrc:compileJava' property 'javaCompiler'.
  > Toolchain installation '/usr/lib/jvm/java-21-openjdk-amd64' does not provide the required capabilities: [JAVA_COMPILER]
```

本机绕过（已在验证中使用，未改 `scripts/`）：`export JAVA_HOME=/home/hancel/jdk-21`（真 JDK 21，`javac 21.0.13`）。
**建议 Lead 修 `scripts/dev-env.sh`：优先选含 `bin/javac` 的 JDK**，否则手机壳构建在标准 dev 环境也会踩坑。

### 1.4 本机 agent 沙箱专用变量（普通开发机不需要）

本机 `~/.cargo`、`~/.rustup`、`~/.gradle`、`~/.android`、`~/.local` 对 agent 只读；以下都指到仓库内 `.cache/`（已在根
`.gitignore`，不提交）：

```bash
export RUSTUP_HOME=$PWD/.cache/rustup-home     # 从 ~/.rustup 复制一份（1.4 GB），否则 rustup target add 报 Read-only
export CARGO_HOME=$PWD/.cache/cargo-home
export CARGO_TARGET_DIR=$PWD/.cache/cargo-target
export GRADLE_USER_HOME=$PWD/.cache/gradle-home # 需要放 gradle 9.6.1 + maven 镜像配置（见下）
export ANDROID_USER_HOME=$PWD/.cache/android-home
export XDG_DATA_HOME=$PWD/.cache/xdg-data       # 否则 Kotlin daemon 写 ~/.local/share/kotlin 失败
export XDG_CACHE_HOME=$PWD/.cache/xdg-cache
```

两个网络/缓存细节（仅沙箱需要，写在 `GRADLE_USER_HOME` 里，不入库）：

1. `services.gradle.org`、`dl.google.com`、`repo1.maven.org` 在本机代理下只有 ~10–25 KB/s。Gradle 9.6.1 发行包改用
   `https://repo.huaweicloud.com/gradle/gradle-9.6.1-bin.zip` 手动放进 wrapper 缓存；
   `GRADLE_USER_HOME/init.d/mirrors.gradle` 把 google/mavenCentral 前置到阿里云镜像
   （`https://maven.aliyun.com/repository/google|public|gradle-plugin`，实测 ~180 KB/s 以上）。
2. 本机代理需要显式给 Gradle JVM：`GRADLE_OPTS="-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7890 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7890"`。

## 2. 生成与构建

### 2.1 一次性生成 Android 工程

```bash
cd apps/mobile
source ../../scripts/dev-env.sh
export JAVA_HOME=/home/hancel/jdk-21          # 有 javac 的 JDK
../../node_modules/.bin/tauri android init    # 生成 src-tauri/gen/android，自动装 4 个 rust target
bash android-extras/apply.sh                  # 壳补丁：MainActivity/前台服务/分享入口 + manifest
```

`tauri android init` 本机输出（节选，成功）：

```
Info Using installed NDK: /home/hancel/Android/Sdk/ndk/28.2.13676358
Info Installing Android Rust targets...
Info Installing target armv7-linux-androideabi
Info Installing target i686-linux-android
Generating Android Studio project...
victory: Project generated successfully!
```

### 2.2 构建 APK

```bash
# 前端产物：frontendDist = ../../web/dist（tauri.conf.json 不跑 beforeBuildCommand，保持与桌面壳一致）
pnpm --filter @crossfile/web build

cd apps/mobile
../../node_modules/.bin/tauri android build --debug        # 调试 APK
../../node_modules/.bin/tauri android build                # release（未签名，仅本地装）
../../node_modules/.bin/tauri android build --debug --target x86_64   # 给 x86_64 模拟器
```

产物：`src-tauri/gen/android/app/build/outputs/apk/<flavor>/<buildType>/app-<flavor>-<buildType>.apk`
（flavor ∈ `arm64 / arm / x86 / x86_64 / universal`；默认单 ABI = arm64 → `app-arm64-debug.apk`）。

> ⚠️ **本机 agent 沙箱内这条命令会失败**（不是工程问题），错误原文：

```
failed to watch /home/hancel/project/cross-file/apps/mobile/src-tauri/Cargo.toml: OS file watch limit reached. about ["/.../src-tauri/Cargo.toml"]
       Error failed to watch /home/hancel/project/cross-file/apps/mobile/src-tauri/Cargo.toml: OS file watch limit reached.
```

原因：沙箱禁止 `inotify_add_watch`（对任意路径都返回 `ENOSPC`；用 Python 直接 syscall 复现：
`inotify_add_watch(/tmp) -> -1 errno 28`），而 Tauri CLI 2.12.6 在加载工程时会起文件 watcher。
普通开发机不受影响。沙箱内的等价流程见 §2.4。

### 2.3 `src-tauri/tauri`（Gradle 桥接 shim）

`tauri android init` 生成的 Gradle 工程里，`buildSrc` 的 `BuildTask` 用
`node tauri android android-studio-script …` 构建 Rust 库（供 Android Studio 内构建用），工作目录是 `src-tauri/`。
`node tauri` 只会按 cwd 解析脚本，因此这里放了一个 4 行的 ESM 转发器（`apps/mobile/package.json` 是 `"type": "module"`，
所以用 `createRequire` 加载 CJS 的 CLI）：

```js
// apps/mobile/src-tauri/tauri
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require('../../../node_modules/@tauri-apps/cli/tauri.js')
```

它只服务 Gradle / Android Studio 内的构建；`tauri android build` 本身不依赖它。

### 2.4 沙箱内的等价构建流程（已验证 ✅）

`tauri android build` 的职责拆成两步手动执行：

```bash
cd apps/mobile/src-tauri
source ../../../scripts/dev-env.sh
export JAVA_HOME=/home/hancel/jdk-21
# 1) Rust 库：cargo 直接构建（CLI 也是这么做的），产物软链进 jniLibs
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES"
cargo build --lib --target aarch64-linux-android
ln -sf "$CARGO_TARGET_DIR/aarch64-linux-android/debug/libcrossfile_mobile_lib.so" \
  gen/android/app/src/main/jniLibs/arm64-v8a/libcrossfile_mobile_lib.so

# 2) Gradle 打包（跳过会调用 CLI 的 rustBuild 任务；Java/Kotlin 资源、清单、签名都在这里）
cd gen/android
./gradlew :app:assembleArm64Debug -PtargetList=aarch64 -PabiList=arm64-v8a -x :app:rustBuildArm64Debug
```

本机结果：

```
BUILD SUCCESSFUL in 1m 17s
62 actionable tasks: 26 executed, 36 up-to-date
app/build/outputs/apk/arm64/debug/app-arm64-debug.apk   116 MB
```

### 2.5 开发模式（需真机/模拟器）

```bash
# 终端 A：Web dev server（Vite :5173）+ 信令
pnpm dev
# 终端 B：装到已连接设备并热重载
cd apps/mobile && ../../node_modules/.bin/tauri android dev --device <serial>
```

- `tauri.conf.json > build.devUrl = http://localhost:5173`：Tauri CLI 会用 adb reverse / 设备可达地址指向开发机，
  与桌面 `dev` 路径一致（本机未验证，无设备）。
- `tauri android dev` 会自动写入 `gen/android/.tauri/cli-options-server.json`，Android Studio 内的 Gradle 构建依赖它。
- `devUrl` 是 `http://` 明文：debug 构建 `usesCleartextTraffic=true`（模板默认），release 为 false；生产连 `wss://` 不受影响。

### 2.6 iOS（本机未做，仅路径）

```bash
# 需要 macOS + Xcode + iOS target；本机是 Linux，无法执行
pnpm --filter @crossfile/mobile ios:init
pnpm --filter @crossfile/mobile ios:dev
```

配置已按跨平台写（identifier、图标、capabilities 通用）；iOS 的保活能力与 Android 不同，见 §4.3。

## 3. 原生保存命令（与桌面壳同一契约）

### 3.1 命令签名（JS 侧不变）

```rust
save_open(name: String) -> u64
save_write(handle: u64, offset: u64, bytes: Vec<u8>)
save_close(handle: u64) -> String          // 最终绝对路径
save_abort(handle: u64)
set_transfer_active(active: bool)
confirm_close()
```

另有手机壳新增（不影响桌面契约）：

```rust
get_shell_config() -> { shell, platform, signalingUrl, saveRoot, saveStrategy, version }
set_keep_awake(active: bool) -> bool        // 可选；set_transfer_active 已自动驱动
```

语义、乱序写、续传、取消删半成品、文件名清洗（`/ \ : * ? " < > |`、控制字符、`..`、同名 ` (1)` 去重）全部与
`docs/desktop.md` §4 一致，实现见 `src-tauri/src/lib.rs`；两份单测（路径穿越、同名去重、注入脚本）3/3 通过。

### 3.2 保存位置

- 目标目录：`app.path().app_data_dir()/downloads`
  - Android：`/data/user/0/com.crossfile.mobile/files/downloads/<name>`
  - iOS：`<app sandbox>/Library/Application Support/com.crossfile.mobile/downloads/<name>`
- 这是**应用私有目录**：卸载即删，文件管理器通常看不到（需要「导出/分享」才会进系统下载）。
- 不做 Android `MediaStore` 直写的原因：API 29+ 分区存储禁止普通文件写入 `/sdcard/Download`；正确做法是
  `MediaStore.Downloads` 插入 + `ContentResolver.openOutputStream` 拷贝。**TODO**（未实现，见 §9）：
  在 Kotlin 侧加 `MediaStoreExport`，由 Rust 在 `save_close` 后调用（需要一条 Rust→Kotlin 的移动插件桥），
  或先做一个「导出到下载目录 / 分享」按钮走 `FileProvider` + `ACTION_SEND/ACTION_VIEW`（模板已带 FileProvider）。
- UI 提示：Web 现在直接展示 `save_close` 返回的路径，手机上会显示 `/data/user/0/...`。**建议 JS 侧**按
  `get_shell_config().platform === "android"` 改成「已保存到应用内下载目录」+ 后续导出按钮（见 §11）。

## 4. 保活：传输中锁屏/切后台不被杀

思路分两层：**屏幕常亮**（WebView 内 Wake Lock）+ **进程优先级**（Android 前台服务）。都已在工程里落地/接好骨架。

### 4.1 屏幕常亮（已实现，无需 Web 改动）

`set_transfer_active(true)`（Web 在每次传输开始/结束都会调）会同时向主 WebView 注入一小段 JS：

```js
navigator.wakeLock.request('screen')      // 部分 WebView 需要页面可见，隐藏时自动释放
document.addEventListener('visibilitychange', …)  // 回到前台自动重新申请
```

释放走 `release()`；`confirm_close()` 也会释放。WebView 支持时等价于 `FLAG_KEEP_SCREEN_ON`；不支持时静默失败，
不影响传输（只是屏幕可能灭）。**未在真机验证实际行为**（无设备，见 §9）。

### 4.2 Android 前台服务（已实现，Kotlin 侧）

`android-extras/kotlin/KeepAliveService.kt` + `apply.sh` 写入的 manifest：

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
…
<service android:name=".KeepAliveService" android:exported="false"
         android:foregroundServiceType="dataSync" />
```

- `MainActivity.onCreate()` 启动服务，`onDestroy()` 且 `isFinishing` 时停止（旋转不会误停）。
- 服务用 `dataSync` 类型 + 常驻低优先级通知（Android 13+ 未授权 `POST_NOTIFICATIONS` 时通知不显示，但服务照常运行）。
- 传输跑在本进程的 WebView 里，所以「服务在 = 进程受保护」，**不需要 Rust↔Kotlin 的命令桥**，也不需要改 Web。
- 效果：锁屏/切后台时进程优先级提高，Android 不会因为「后台空闲」马上回收；Dozer/厂商省电策略仍可能干预（§9）。
- 已知边界：Android 15+ 对 `dataSync` 前台服务有 6 小时/天的上限（超时会回调 `onTimeout`，本骨架未处理）；
  用户从最近任务划掉应用会结束任务（服务随之停止），这是 Android 设计，无法绕过。

### 4.3 iOS

无「前台服务」等价物：App 进后台后 WKWebView 的 JS/WebRTC 会被系统挂起（几十秒内），无法持续传输。
可用的正规路径是原生 `NSURLSession` 后台下载（仅适用于下载，且要重写传输层），超出 v1 范围。
iOS v1 只能在 UI 上提示「传输期间请保持应用在前台」；屏幕常亮可用 `navigator.wakeLock`（iOS 16.4+ / WKWebView）。
**未验证**（本机无 macOS/Xcode）。

## 5. 分享面板接收（ACTION_SEND）：骨架，未接线

已完成：

- manifest 给 `MainActivity` 加 `ACTION_SEND`（`*/*`）+ `singleTask`，冷启动/热启动都会进 `onNewIntent`。
- `ShareIntake.kt`：从 `content://` 读 `DISPLAY_NAME`，把文件流式拷到 `cacheDir/share-inbox/<name>`，
  写 `filesDir/pending-share.json`（name/path/size/receivedAt）。全程在后台线程，失败静默。
- APK 已确认包含该 intent-filter 与 Kotlin 类（`classes6.dex`）。

未完成（写清路径）：

1. **把分享结果交给 Web**：最省事的方案是 Kotlin 里发一个 Tauri 事件，但 Tauri 2 的 Android 事件只能从
   Rust 发（`app.emit(...)`），Kotlin 侧需要注册一个移动插件（`Plugin` 子类 + `trigger()`），再在 Rust 侧
   `PluginHandle::run_mobile_plugin` 或直接由 Kotlin 触发事件——这需要一条 Rust↔Kotlin 桥。
   另一条不改 Rust 的路径：Rust 在 `setup()` 里扫描上面那个 `pending-share.json`，命中就 `app.emit("share-received", …)`
   并删除标记；只覆盖**冷启动**分享（热启动仍需桥）。
2. **JS 消费**：Web 收到 `share-received` 后把文件加进「发送文件列表」（需要 Lead 在 `apps/web` 加监听 + 调用现有
   文件选择/添加逻辑；手机端再加一个「从文件管理器选文件」的原生 picker 更实用）。
3. 文件选择器（`ACTION_OPEN_DOCUMENT`）同理，建议和分享一起做成「移动端文件入口」，排在 AC9 之后。

结论：**可选加分项，本次只交付 intent + 落盘骨架**，端到端未通。

## 6. 返回手势不中断传输

- Tauri 2 Android 的 WebView 默认行为：**返回手势/返回键会先交给 WebView**（页面有 history 时后退），
  history 为空时 Activity 被 finish → 应用退出 → WebRTC 传输中断、进程可能被回收。桌面的 `CloseRequested`
  关窗保护在 Android 上不覆盖返回手势。
- 本壳的配置：`android-extras/kotlin/MainActivity.kt` 用 `OnBackPressedCallback` 消费返回事件，改调
  `moveTaskToBack(true)`：**退到后台而不是销毁 Activity/WebView**，配合 §4.2 的前台服务，传输继续。
  用户在最近任务里划掉才是真正结束（Android 语义，无法拦截）。
- 要「返回时弹确认」而不是直接退后台：在 callback 里向 Web 发事件（同 §5 的桥问题），由 Web 弹自己的确认框；
  当前 v1 选择直接退后台，最省事且不丢传输。
- iOS：没有返回键；上滑回桌面 = 进后台，受 §4.3 限制。

## 7. 信令地址与壳全局注入（JS 侧零改动）

手机 WebView 的 `location` 是 Tauri 自定义 origin，Web 里「同源推导 `/v1/ws`」不可用；而 `signal.ts` 的解析顺序是
`window.__CROSSFILE_SIGNALING_URL__` → `localStorage["crossfile.signalingUrl"]` → 原生壳默认（`ws://127.0.0.1:8788`）→ 同源。
手机壳在页面加载完成（`Builder::on_page_load`）和 `setup()` 各注入一次：

```js
window.__CROSSFILE_SHELL__ = 'mobile'
window.__CROSSFILE_NATIVE__ = true                       // 能力包走 native 保存策略
window.__CROSSFILE_SIGNALING_URL__ ||= 'wss://room.net.time-pack.com/v1/ws'
```

- 默认值 `wss://room.net.time-pack.com/v1/ws`（官方实例）；构建/运行时可被环境变量 `CROSSFILE_SIGNALING_URL` 覆盖
  （`std::env::var`，构建期 env 会进二进制，适合自托管打包）。
- 注入时机在 Web 读取之前（读发生在建/加房时，不是模块加载时），所以**不需要改 `apps/web`**。
- 另提供 `get_shell_config()` 返回 `{shell:"mobile", platform:"android"|"ios", signalingUrl, saveRoot, saveStrategy:"native", version}`，
  给将来的设置页/诊断页用。

## 8. 本机验证记录（2026-11-24，Linux）

| 项                  | 命令                                                                 | 结果                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust 编译（Android）| `cd apps/mobile/src-tauri && cargo check --target aarch64-linux-android` | ✅ `Finished dev profile [unoptimized + debuginfo] target(s) in 0.45s`，0 warning（首次含依赖约 1 分钟）                                                                                             |
| Rust 编译（链接）   | `cargo build --lib --target aarch64-linux-android`（带 NDK linker 环境） | ✅ `Finished dev profile … in 17.89s`，产出 `libcrossfile_mobile_lib.so`                                                                                                                            |
| 单元测试（host）    | `cargo test`                                                          | ✅ 3 passed / 0 failed（文件名穿越、同名去重、信令注入脚本）                                                                                                                                         |
| Android 工程生成    | `tauri android init`                                                  | ✅ `Project generated successfully!`；自动安装 armv7/i686 等 4 个 rust target                                                                                                                        |
| CLI 构建            | `tauri android build --debug`                                         | ❌ 沙箱阻断：`failed to watch …/Cargo.toml: OS file watch limit reached`（`inotify_add_watch` 对任意路径返回 ENOSPC，Python syscall 复现；非工程问题）。普通开发机应可正常跑                         |
| 等价构建（Gradle）  | `./gradlew :app:assembleArm64Debug -PtargetList=aarch64 -PabiList=arm64-v8a -x :app:rustBuildArm64Debug` | ✅ `BUILD SUCCESSFUL in 1m 17s`，`app-arm64-debug.apk` 116 MB                                                                                                                                       |
| APK 内容            | `aapt2 dump badging` / `unzip -l`                                     | ✅ `package=com.crossfile.mobile`、`minSdk 24`、`targetSdk 37`、`versionName 0.1.0`；含 `lib/arm64-v8a/libcrossfile_mobile_lib.so`、`assets/tauri.conf.json`；manifest 含 `KeepAliveService`（`foregroundServiceType=0x1`=dataSync）、`MainActivity`（`launchMode=2`=singleTask）、`action.SEND`；`classes6.dex` 含 KeepAliveService |
| 模拟器启动          | `emulator -accel-check` / `emulator -avd Medium_Phone_API_37.0 -no-window …` | ❌ 无 `/dev/kvm`：`accel: 8 / /dev/kvm is not found: VT disabled in BIOS or KVM kernel module not loaded`；另外 AVD 目录在只读 HOME 下，`touch …/bootcompleted.ini: 只读文件系统`，启动时报 `FATAL | A snapshot operation … pending and timeout has expired` |
| 安装/启动/logcat    | `adb install` / `adb shell am start`                                 | ❌ 未执行：`adb devices` 为空（无真机、模拟器起不来）                                                                                                                                                 |

诚实说明：**「APK 能产出」已验证；「APK 能装、能启动、WebView 能跑、500MB 能传」均未验证**。
AC9 的手机侧仍缺一次真机（或用带 KVM 的机器/云端模拟器）实跑。

## 9. 已知限制 / 未验证项

1. **无设备验证**：本机无 `/dev/kvm`、无真机，APK 未安装运行；WebView 启动、保存路径、前台服务行为、
   Wake Lock、返回手势、分享 intent 全部只有静态证据（编译/清单/构建产物），没有运行时证据。
2. **iOS 完全未构建**（无 macOS/Xcode）；后台传输在 iOS 上不可行（§4.3）。
3. **保存目录是应用私有目录**：`save_close` 返回 `/data/user/0/...`，用户无法直接用文件管理器打开；
   MediaStore 导出 / 分享按钮是 TODO（§3.2、§5）。
4. **分享面板只到「拷进 cache + 写标记」**，Web 侧没有入口；需要 Rust↔Kotlin 事件桥（§5）。
5. **Android 14/15 前台服务限制**：`dataSync` 6 小时/天、需要 `POST_NOTIFICATIONS` 才显示通知、厂商省电策略可能仍杀进程；
   需要实测（尤其国产 ROM）。
6. **`tauri android build` 在本沙箱不可用**（inotify），CI/其他机器需再验证一次；本机按 §2.4 等价流程出货。
7. **JSON IPC 吞吐**：`save_write` 与桌面一样走 JSON 数字数组，500 MB 会有编码开销（`Array.from`）。
   手机 CPU/内存更紧，AC9 手机侧实测前建议评估加 raw 通道（Tauri 2 `Channel`/raw request）。
8. **未签名**：debug 用 Gradle 默认调试签名；release 未配 keystore，`tauri android build` 的 release APK 不能直接分发。
9. **AGP 9 / Gradle 9 模板较新**：`gen/android` 是 Tauri CLI 2.12.6 生成的，Android Studio 版本过低会提示升级；
   模板警告 `testVariants/libraryVariants` 已废弃（Tauri 上游问题，不影响构建）。
10. **未做单实例/深链**：`singleTask` 只保证分享复用 Activity；没有 `tauri-plugin-deep-link`。
11. **CSP 仍为 null**（与 Web/桌面一致），发布前应收紧。

## 10. 故障排查

| 现象 | 处理 |
| --- | --- |
| `Toolchain installation … does not provide the required capabilities: [JAVA_COMPILER]` | `JAVA_HOME` 指到了 JRE；改用真 JDK（本机 `/home/hancel/jdk-21`），或修 `scripts/dev-env.sh` |
| `failed to watch …: OS file watch limit reached` | 沙箱/容器禁止 inotify（本机如此）；普通机器加大 `fs.inotify.max_user_instances`。沙箱内用 §2.4 |
| `Cannot find module '…/src-tauri/tauri'`（Gradle 里） | `src-tauri/tauri` 转发 shim 缺失或被删；从仓库恢复（§2.3） |
| Kotlin daemon 报 `~/.local/share/kotlin/daemon/…: Read-only file system` | `export XDG_DATA_HOME=<可写目录>`（沙箱）；普通机器删掉只读挂载即可 |
| Gradle 卡在 `Downloading https://services.gradle.org/distributions/gradle-9.6.1-bin.zip` | 网络问题；用镜像下 zip 放进 `$GRADLE_USER_HOME/wrapper/dists/gradle-9.6.1-bin/<hash>/` 并解压 + `touch *.ok` |
| 依赖解析极慢（google()/mavenCentral()） | `$GRADLE_USER_HOME/init.d/mirrors.gradle` 前置阿里云镜像（§1.4） |
| `compileSdk 37` 找不到平台 | 确认 `$ANDROID_HOME/platforms/android-37.0` 存在（本机是这个目录名）；否则装 `platforms;android-37` |
| 启动 APK 白屏 / 连不上信令 | 先看 `adb logcat \| grep -i tauri`；信令地址必须注入 `wss://…`（§7），release 默认禁止明文 http |
| 传输中锁屏就断 | 确认前台服务已启动（通知出现 / `adb shell dumpsys activity services \| grep KeepAlive`）；华为/小米等需关电池优化 |

## 11. 需要 Lead / JS 侧配合的点

1. **根 `pnpm install`**：新增 `@crossfile/mobile` importer 需要更新 `pnpm-lock.yaml`（本任务按约定没有执行 install）。
   根 `pnpm build` / `pnpm test` 不受影响（手机壳没有 `build` 脚本，vitest 只收 `*.test.ts`）。
2. **`scripts/dev-env.sh` 的 `JAVA_HOME`**：本机指向 JRE，Gradle 构建必失败；建议改成「优先 `bin/javac` 存在的 JDK」。
3. **保存成功后的 UI**：手机返回的是应用私有路径；建议按 `get_shell_config().platform` 换成
   「已保存到应用内下载目录」，并在 M-next 加「导出/分享」按钮（FileProvider 已在模板里）。
4. **分享/文件选择入口**（可选）：需要 `apps/web` 监听 `share-received` 事件，或做一个原生文件 picker；
   当前壳只落盘、未发事件（§5）。
5. **信令地址**：默认 `wss://room.net.time-pack.com/v1/ws` 已由壳注入，`apps/web` 无需改动；
   若 Lead 想统一「壳配置接口」，可直接用 `invoke("get_shell_config")` 读同一个值。
6. **AC9 手机侧验收**：需要一台真机或带 KVM 的模拟器环境（本机不具备）；拿到设备后按 §2.2/§2.4 出 APK、
   `adb install -r`、`adb shell am start -n com.crossfile.mobile/.MainActivity`，`adb logcat` 抓 WebView 启动，
   再跑 500 MB 用例并记录保存路径 / 通知 / 前后台切换行为。

---

## 调试/自动化钩子（仅 debug 构建）

Android 与 iOS 的 debug 构建会读取三个运行期环境变量，配合主机侧的验收脚本可以无人值守跑通接收流程：

| 环境变量 | 作用 |
|---|---|
| `CROSSFILE_SIGNALING_URL` | 信令地址（默认 `ws://127.0.0.1:8788/v1/ws`），自托管/测试实例用 |
| `CROSSFILE_DEV_JOIN` | 启动后自动 `location.href` 跳到房间链接（带 `#` 下的 roomKey） |
| `CROSSFILE_DEV_AUTOACCEPT=1` | 允许页面在带 `?autoaccept=1` 时自动接收，无需点按（release 构建不读它） |

iOS 模拟器示例（App 安装后）：

```bash
LINK=$(curl -sS http://<host>:8099/link.txt)
xcrun simctl terminate booted <bundle-id> 2>/dev/null
SIMCTL_CHILD_CROSSFILE_SIGNALING_URL="wss://<domain>/v1/ws" \
SIMCTL_CHILD_CROSSFILE_DEV_JOIN="$LINK" \
SIMCTL_CHILD_CROSSFILE_DEV_AUTOACCEPT=1 \
  xcrun simctl launch booted <bundle-id>
# 落盘位置（应用沙盒内）
xcrun simctl get_app_container booted <bundle-id> data
```

注意：native 写入的 IPC 载荷是 **base64 字符串**（`save_write(bytesB64)`），不是数字数组；
调试壳的 `CROSSFILE_DEV_JOIN` 会在应用自身 origin 内打开房间（`?devroom=&devkey=`），因为 iOS 上
Tauri ACL 不允许远程 https 页面调用自定义命令。

已实测（mac-mini + iPhone 17 模拟器 + Linux 主机）：强制两端 `?relay=1` 时，iOS 壳经 TURN 收下
**100 MB 与 500 MB**，落盘 sha256 均与发送方一致（500 MB：`f5b7ea08…`）。模拟器 ↔ Linux 的直连 ICE 不通，
验收脚本请带 `relay=1`。

安全说明：`CROSSFILE_DEV_AUTOACCEPT` 只在 `cfg!(debug_assertions)` 下生效，且必须链接里带 `autoaccept=1`；
release 包即使设置该变量也不会绕过接收方的同意步骤。
