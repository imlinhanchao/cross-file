# CrossFile signaling (Go)

一个静态链接的 Go 二进制，替换原来两件事：

1. `packages/signaling` 的 Node 信令服务器（协议 v2，`/v1/ws`，与现有 Web / 桌面 / Android 客户端
   零改动兼容）；
2. 独立的 coturn 容器：进程内用 [pion/turn v4](https://github.com/pion/turn) 起 UDP + TCP TURN，
   沿用 coturn `static-auth-secret` 的 REST 凭据算法。

同时把构建好的 Web 应用（`apps/web/dist`）用 `//go:embed` 打进二进制，同源托管；`STATIC_DIR`
可覆盖为磁盘目录（开发用）。零存储红线保持不变：无数据库、无文件写入、无 cookie、无访问日志，
stdout 只有一行启动信息。

## 构建

```bash
# 构建 Web + 嵌入 + 编译二进制（输出 apps/signaling-go/bin/crossfile-signaling）
apps/signaling-go/build.sh

# 只编译 Go 二进制（CI / e2e 用；不要求 apps/web/dist 存在）
SKIP_WEB=1 bash apps/signaling-go/build.sh
```

- 构建缓存默认使用仓库内 `.cache/go`、`.cache/go/pkg/mod`、`.cache/go-build`，可用
  `GOPATH` / `GOMODCACHE` / `GOCACHE` 覆盖（`$HOME` 只读的环境也能构建）。
- 交叉编译直接传 `GOOS` / `GOARCH` / `CGO_ENABLED=0`，例如
  `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 SKIP_WEB=1 bash apps/signaling-go/build.sh`。
- 生成物约 10 MB（含 Web 资源；`-trimpath -ldflags="-s -w"`）。

## 运行

```bash
apps/signaling-go/bin/crossfile-signaling
# stdout 只有一行：
# [crossfile-signaling] listening on ws://127.0.0.1:8788/v1/ws turn=off
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址；容器内用 `0.0.0.0` |
| `PORT` | `8788` | HTTP + WebSocket 端口 |
| `MAX_MEMBERS` | `4` | 房间成员上限（**不含管理员**；官方实例用 2）；旧名 `MAX_GUESTS` 兼容，非法值启动失败 |
| `RATE_LIMIT_MAX` | `120` | 每 IP 信令预算（条/窗口）；测试专用逃生口 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 上述窗口 |
| `STATIC_DIR` | 空 | 覆盖内嵌 Web 目录（开发用） |
| `TURN_SECRET` | 空 | coturn `static-auth-secret`；空 = 不启动 TURN、不下发凭据 |
| `TURN_URIS` | 空 | 下发给客户端的 TURN URI，逗号分隔；空 = 不下发凭据 |
| `TURN_EXTERNAL_IP` | 空 | 客户端可达的中继地址；**设置 `TURN_SECRET` 时必填**，否则启动失败 |
| `TURN_LISTEN_PORT` | `3478` | TURN UDP + TCP 监听端口 |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49160` / `49200` | 中继端口范围（含端点） |

行为要点：

- 进程内 TURN 只在 `TURN_URIS` 非空 **且** `TURN_SECRET` 有值时启用（与 Node `dev.ts` 的
  turn 选项门禁一致）。任一为空：不启动 TURN、`created` / `join_ok` 不含 `turn` 字段。
- 启用 TURN 时 `TURN_EXTERNAL_IP` 必填（中继在进程内，必须知道客户端可达地址），缺失即启动失败；
  `TURN_LISTEN_PORT`（默认 3478）被占用时启动失败并在 stderr 说明端口。
- TURN 凭据：`username = "<expiryEpoch>:<memberId>"`，
  `credential = base64(HMAC-SHA1(TURN_SECRET, username))`，TTL 3600 秒（docs/02 §6.8）。
- 进程内 TURN 的日志被完全丢弃（docs/02 §7 只允许启动信息；pion 会在每次分配/鉴权时打日志）。
- `SIGTERM` / `SIGINT`：5 秒内优雅退出（清空内存房间、计数器和 socket，关闭 TURN）。

## 端点

- `GET /v1/ws`（WebSocket upgrade）：协议 v2 信令，见 `docs/02-protocol.md` §3。
- `GET /` 及其他路径：内嵌 Web 应用；SPA 回退到 `index.html`；`assets/` 带 immutable 缓存；
  响应带 `referrer-policy: no-referrer`、`nosniff`、`permissions-policy`、CSP。
- `/v1/` 的普通 HTTP 请求：安静的 `404 not found`（无访问日志）。

## 测试

```bash
cd apps/signaling-go
go test ./...            # 88+ 单测，含假时钟的 60 s 离线窗口 / 10 min 短码 TTL / 限流窗口
go test -race ./...      # 并发检查
gofmt -l .               # 必须为空
go vet ./...
```

端到端（需要浏览器与 Vite）：

```bash
E2E_SERVER=go pnpm exec playwright test                    # 全量
E2E_SERVER=go E2E_RELAY=1 TURN_SECRET=... \
  TURN_URIS='turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp' \
  TURN_EXTERNAL_IP=127.0.0.1 pnpm exec playwright test tests/e2e/ac2-relay.spec.ts
```

## 与 Node 实现的已知差异

- 默认端口：`server.ts` 的库默认是 8787，但进程入口 `dev.ts`（本二进制替换的对象）默认
  **8788**，这里沿用 8788。
- `TURN_SECRET` 已设置而 `TURN_EXTERNAL_IP` 缺失时**启动失败**（原 Node 只负责签发凭据，
  TURN 在 coturn 侧；现在中继在进程内，必须知道对外地址）。自托管升级时需要补这个变量。
- 进程内 TURN 日志被丢弃（原 coturn 可自行配置日志级别）。
- 除上述之外，房间状态机、消息字段、错误码、限流、短码、重连窗口、昵称去重、TURN 凭据算法
  均按 `packages/signaling/src/*` 与 `docs/02-protocol.md` 逐条移植，并由 Go 测试覆盖。
