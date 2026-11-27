# CrossFile signaling (Go)

一个静态链接的 Go 二进制，负责两件事：

1. 信令服务器（协议 v2，`/v1/ws`，与现有 Web / 桌面 / Android 客户端配合）；
2. 进程内用 [pion/turn v4](https://github.com/pion/turn) 起 UDP + TCP TURN，沿用 coturn
   `static-auth-secret` 的 REST 凭据算法。

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
| `MAX_MEMBERS` | `4` | 房间成员上限（**不含管理员**；官方实例用 2）；非法值启动失败 |
| `RATE_LIMIT_MAX` | `120` | 每 IP 信令预算（条/窗口）；测试专用逃生口 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 上述窗口 |
| `RECONNECT_WINDOW_MS` | `60000` | 成员离线窗口 + 管理员移交窗口（测试逃生口，e2e 可缩短）；非法值启动失败 |
| `STATIC_DIR` | 空 | 覆盖内嵌 Web 目录（开发用） |
| `TURN_SECRET` | 空 | coturn `static-auth-secret`；空 = 不启动 TURN、不下发凭据 |
| `TURN_URIS` | 空 | 下发给客户端的 TURN URI，逗号分隔；空 = 不下发凭据 |
| `TURN_EXTERNAL_IP` | 空 | 客户端可达的中继地址；**设置 `TURN_SECRET` 时必填**，否则启动失败 |
| `TURN_LISTEN_PORT` | `3478` | TURN UDP + TCP 监听端口 |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49160` / `49200` | 中继端口范围（含端点） |

行为要点：

- 进程内 TURN 只在 `TURN_URIS` 非空 **且** `TURN_SECRET` 有值时启用。任一为空：不启动 TURN、
  `created` / `join_ok` 不含 `turn` 字段。
- 启用 TURN 时 `TURN_EXTERNAL_IP` 必填（中继在进程内，必须知道客户端可达地址），缺失即启动失败；
  `TURN_LISTEN_PORT`（默认 3478）被占用时启动失败并在 stderr 说明端口。
- TURN 凭据：`username = "<expiryEpoch>:<memberId>"`，
  `credential = base64(HMAC-SHA1(TURN_SECRET, username))`，TTL 3600 秒（docs/02 §6.8）。
- 进程内 TURN 的日志被完全丢弃（docs/02 §7 只允许启动信息；pion 会在每次分配/鉴权时打日志）。
- `SIGTERM` / `SIGINT`：5 秒内优雅退出（清空内存房间、计数器和 socket，关闭 TURN）。

## 阶段 2：管理权移交（ADR 0010 D24）

管理员 socket 断开时（`adminOffline=true`）会同时启动一个 `RECONNECT_WINDOW_MS`（默认 60 s）的移交计时器；
房间本身仍保留到 30 min TTL。

- 计时器到期前管理员用 `create`（同 `roomId`）或 `join`（带 admin `rejoinToken`）回来 → 取消计时器，一切照旧。
- 计时器到期且管理员仍离线：从成员中选**加入顺序最早、`state=="joined"` 且 socket 仍在线**的一个，
  晋升为新管理员：该成员记录从 `members[]` 移除，`adminId/adminName/adminCaps/adminSocket` 换成它，
  绑定其连接为 `role=admin`，生成新的 `adminRejoinToken`；房间 6 位码保持不变。随后按顺序：
  先向新管理员发送既有的 `created` 消息（`roomId`、**未变的 6 位码**、`selfId`、`name`、`members`、
  **新的 `rejoinToken`**、`turn?`）——这是「你现在是管理员」的既有信号，客户端无需新增消息即可拿到
  邀请码和新 token；再向全房间广播 `members`（新管理员 `isAdmin=true`、旧管理员消失）；
  最后把等待中的 `join_request` 重放给新管理员。
- 没有符合条件的在线成员 → 不移交、不重试，房间继续存活到 TTL。
- 旧管理员身份作废：之后 `create` 同 `roomId` 得到 `ROOM_CLOSED "room already has a connected admin"`，
  用旧 `rejoinToken` 的 `join` 得到 `ROOM_NOT_FOUND "rejoin token is invalid or expired"`；它可以作为普通成员
  重新 `join`，等待新管理员批准。
- 新管理员的心跳续期、`close`、`approve/deny/remove` 全部按管理员语义生效；新管理员再次离线会重新计时，
  到期后移交给下一个最早加入的在线成员（可连续移交）。

客户端无需新增消息：身份变化通过 `members` 广播体现（旧客户端仍能连接并传输）。

`caps` 由服务端**原样透传**（不解释、不落盘），供客户端展示与能力判断。

## 端点

- `GET /v1/ws`（WebSocket upgrade）：协议 v2 信令，见 `docs/02-protocol.md` §3。
- `GET /` 及其他路径：内嵌 Web 应用；SPA 回退到 `index.html`；`assets/` 带 immutable 缓存；
  响应带 `referrer-policy: no-referrer`、`nosniff`、`permissions-policy`、CSP。
- `/v1/` 的普通 HTTP 请求：安静的 `404 not found`（无访问日志）。

## 测试

```bash
cd apps/signaling-go
go test ./...            # 100+ 单测，含假时钟的 60 s 离线/移交窗口、10 min 短码 TTL、限流窗口
go test -race ./...      # 并发检查
gofmt -l .               # 必须为空
go vet ./...
```

端到端（需要浏览器与 Vite）：

```bash
pnpm exec playwright test                                   # 全量（默认信令就是本二进制）
E2E_RELAY=1 TURN_SECRET=... \
  TURN_URIS='turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp' \
  TURN_EXTERNAL_IP=127.0.0.1 pnpm exec playwright test tests/e2e/ac2-relay.spec.ts
```
