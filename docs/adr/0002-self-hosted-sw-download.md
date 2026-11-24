# ADR 0002 — Safari/iOS 保存：自研 Service Worker 流式下载

状态：待验证（M2）

## 背景
附录 C A1b：StreamSaver.js 在 Safari 会退回 Blob 兜底（峰值 ≈2× 内存）；iOS Safari 现场报告 512 MB 可过、1.4 GB 标签页被杀。

## 决定
- 接收端保存层抽象成 `sink`：`native | fs | sw | blob`（docs/02 §6.8）。
- `sw` 策略自研：页面经 `MessageChannel` 把解密分片推给同源 Service Worker，SW 用 `Response(stream)` + `Content-Disposition: attachment` 交给浏览器下载管理器增量写盘；一次性 token 校验。
- 未通过实测前，能力矩阵维持 iOS 100 MB / Safari 250 MB 软上限。
- 不引入第三方 StreamSaver。

## 后果
- 需要 M2 在 macOS Safari 27 上实测 500 MB 内存曲线；失败则维持保守阈值并只推原生壳。
