# 附录 C — Safari 落盘与鸿蒙 ArkWeb 事实核查

> 核查日期：2026-11-24 ｜ 方法：官方文档/WebKit bug/OpenHarmony 源码 + 既有现场报告
> 用于更新 `01-design.md` §6 能力矩阵与 `03-roadmap.md` 风险 R1/R2。

---

## A. Safari 大文件保存

| # | 事实 | 置信度 | 出处 |
|---|---|---|---|
| A1 | **Safari 15.4+ 支持 Service Worker 流式下载**：SW 里 `respondWith(new Response(stream))` + `Content-Disposition: attachment`，由网络进程的下载管理器**增量写盘**，不经过页面内存 | 存在性 HIGH / 确切版本 MEDIUM | https://bugs.webkit.org/show_bug.cgi?id=202142 |
| A1b | **但 StreamSaver.js 在 Safari 仍走 Blob 兜底**（UA 检测把 WebKit 全归到 fallback，`close()` 时再整份复制，峰值 ≈2× 内存）；需要 `useBlobFallback=false` 或自研 | HIGH | https://github.com/jimmywarting/StreamSaver.js/issues/373 ／ /374 ／ /69 |
| A2 | SW 中 `Response` 流式可用；SW 返回 `Transfer-Encoding: chunked` **无权威文档**；下载无已知大小时 Safari 不显示原生进度 | 流 HIGH / chunked 未验证 | https://caniuse.com/streams ；StreamSaver issue #260 |
| A3 | `URL.createObjectURL` 无文档化内存上限；WebKit 在内存压力下会杀 WebContent 进程 | 上限 UNVERIFIED | https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static |
| A4 | iOS：`download` 属性自 iOS 13.0；Blob URL **不流式**，`new Blob(chunks)` 峰值 ≥2×；现场报告 iOS 15.4 Safari **512MB 成功**，1.41GB（分 7 文件）在 `close()` 时标签页被杀，11.9GB 失败 | MEDIUM-HIGH | https://github.com/jimmywarting/StreamSaver.js/issues/287 ／ /373 |

**设计含义**：接收端保存层要抽象成 sink，按能力选：`native`（壳直接写盘）/ `fs`（Chromium 桌面文件系统 API）/ `sw`（Safari 15.4+ 自研 Service Worker 流式下载）/ `blob`（兜底）。Safari 与 iOS 都可能把 500MB 拉到可用，但**必须自研并通过 M1/M2 实测**；StreamSaver.js 不可直接采用。

---

## B. 鸿蒙 HarmonyOS NEXT（ArkWeb）

| # | 事实 | 置信度 | 出处 |
|---|---|---|---|
| B1 | ArkWeb 内核版本：≤OH 4.0 = Chromium M99；4.1–5.1 = M114；**OH 6.0/6.1 = M132**（可选 M114）；OH 7.0 = M144 | HIGH（OpenHarmony 源码；华为发行版可能略有差异） | https://gitee.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-component-overview.md |
| B1b | UA 形如 `... Chrome/132.0.0.0 ... ArkWeb/4.1.6.1 Mobile`，可用于识别 | HIGH | https://gitee.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-default-userAgent.md |
| B2 | **没有逐 API 支持矩阵**；官方仅文档化了 WebRTC 媒体（`getUserMedia` + `onPermissionRequest`，需相机/麦克风权限）。SW / WebSocket / WebCrypto / WASM / **RTCDataChannel 均未文档化**——但都是 M132/M144 的 Chromium 基线能力 | 逐 API 未验证 LOW | https://gitee.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-rtc.md |
| B3 | HarmonyOS NEXT 无 AOSP/APK 兼容，只跑 HAP；没有 Chrome/Edge/Firefox 的鸿蒙版本 | MEDIUM | https://en.wikipedia.org/wiki/HarmonyOS_NEXT |
| B4 | 第三方 ArkTS 应用内嵌 ArkWeb `Web` 组件：`getUserMedia` + 权限回调有文档；RTCDataChannel 未文档化 | 媒体 HIGH / 数据通道 UNVERIFIED | 同 B2 |
| B5 | 下载由原生处理：`WebDownloadDelegate` / `setDownloadDelegate()`，字节先落 `/data/storage/el2/base/cache/web/Temp/`，`WebDownloadItem.start(path)` 续写；用户保存走 `picker.DocumentPickerMode.DOWNLOAD`；**无 500MB 上限文档** | HIGH / 上限未验证 | https://gitee.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-download.md |
| B6 | `navigator.share` 未在 ArkWeb 文档中出现（未验证）；文件接收/选择支持（`<input type="file">` → `onShowFileSelector()`） | 未验证 / HIGH | https://gitee.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-file-upload.md |

**设计含义**：鸿蒙走浏览器「基本可行」——ArkWeb 是 Chromium 132/144，数据通道大概率支持；但官方未文档化，必须实测。若不行，鸿蒙端需要原生 HAP 壳，成本整个变一个量级。

---

## C. 本机鸿蒙测试能力（可直接用于 M4/M5）

- Command Line Tools **26.0.0.821**：`/home/hancel/harmonyos/command-line-tools`（`source /home/hancel/harmonyos/env.sh` 设 PATH 与 `DEVECO_SDK_HOME`）。
- `hdc 3.2.0f`、`ohpm 26.0.0.630`、`hvigor 6.26.4`、内嵌 Node v24.14.1。
- Emulator 26.0.0（约 131MB，可 `-noWindow` 无头运行），SDK **API 26**；镜像在 `~/.Huawei/Emulator`；示例工程 `/home/hancel/harmonyos/apps/HelloHarmony`。
- 限制：**模拟器不是真机**，可做 ArkWeb HAP 冒烟测试（WebRTC 数据通道、SW、WebCrypto），但真机 UA/浏览器行为仍需真机复验。

---

## 结论对设计的修正

1. Safari/iOS「零安装收 500MB」从「大概率不行」升级为「**可能可行，需自研 SW 流式下载并实测**」——能力矩阵暂维持保守阈值，M1/M2 验证通过后放宽。
2. 鸿蒙（ArkWeb M132+）风险从「可能不支持 WebRTC」降为「**需实测确认**」，本机模拟器可覆盖冒烟测试。
3. 保存层新增 `sw` 策略与 `swDownload` 能力字段，见 `02-protocol.md` §5 / §6.8。
