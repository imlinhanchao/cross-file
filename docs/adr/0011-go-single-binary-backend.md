# ADR 0011 — Go 单二进制后端（内嵌 Web 与 TURN，移除 Node 与 coturn）

状态：已采纳（2026-11-27）；生产已切换（v0.2.0），Node 实现已从仓库移除

## 背景

阶段 1 的服务端由两部分组成：`packages/signaling`（Node 22 + `ws` 的 TypeScript 信令服务，同源托管 Web
产物）与独立的 coturn（TURN 中继）。生产部署是「nginx → PM2（Node）→ 静态资源目录 + coturn 进程」。
这套结构能跑，但运维面与发布面都偏重：

- 服务器需要 Node 运行时；单文件备选是 Node SEA，体积 123 MB 且仍标 experimental；
- 两个进程（signaling + coturn）要分别配置、分别保活、分别审计；TURN 的 `static-auth-secret` 与 signaling
  的签发逻辑必须保持一致；
- 零存储审计要同时覆盖 Node bundle 与容器镜像，容器路径还要构建前端；
- 冷启动内存 ~65 MB，容器镜像与发布产物都偏大。

与此同时，信令服务本身是一个很小的状态机（房间/成员表 + 转发），协议 v2 已经把「任意成员 `signal`」的形状
定死（ADR 0010），因此存在一个低成本替换路径：用 Go 重写服务端，把 Web 产物与 TURN 一起放进**一个静态
二进制**，协议与客户端零改动。

## 决定

1. **用 Go 重写信令服务**，新目录 `apps/signaling-go/`；协议仍为 v2（`PROTOCOL_VERSION = 2`），消息表、
   错误码、状态机语义、TURN 凭据算法全部与 Node 实现逐项对齐。**客户端零改动**（Web/桌面/Android 壳）。
2. **单进程内嵌三件事**：HTTP 静态托管（`//go:embed all:webdist`，`STATIC_DIR` 可覆盖）、`/v1/ws` 信令、
   in-process TURN（`github.com/pion/turn/v4`，UDP+TCP 3478，relay 49160–49200，realm `crossfile`，
   `turn.LongTermTURNRESTAuthHandler` 沿用 coturn `static-auth-secret` 的 REST 凭据）。
3. **TURN 门禁与 Node 一致**：`TURN_URIS` 非空且 `TURN_SECRET` 设置才启动内嵌 TURN 并下发凭据；此时
   `TURN_EXTERNAL_IP` 必填（公网 relay 通告地址），缺失则启动失败。`TURN_URIS` 为空 = 不提供 TURN。
4. **零存储红线不变**：无数据库、无文件写入、无 cookie、无访问日志；stdout 只有 1 行启动信息；pion 的
   per-allocation/auth 日志全部丢弃；SIGTERM 优雅关闭并清空内存。
5. **构建与发布**：`apps/signaling-go/build.sh` 先构建 Web（除非 `SKIP_WEB=1`）、复制到 `webdist/`、再
   `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"`；发布产物为 linux amd64/arm64 的 tarball（二进制 +
   `interpreter: "none"` 的 `ecosystem.config.cjs` + `VERSION`）与裸二进制；tarball 资产名保持不变，
   `deploy.yml` 无需区分 Node/Go（每个 release 自带自己的 PM2 配置）。
6. **保留 Node 实现直到生产验收通过**，随后**从仓库移除** `packages/signaling`、`infra/signaling` 的 Node
   构建脚本与 `infra/pm2/ecosystem.config.cjs`；回滚路径改为「部署旧 release（v0.1.0）+ 重新启用 coturn」，
   不依赖仓库里的 Node 源码。
7. **CI/审计**：`ci.yml` 增加 `go`（gofmt/vet/test/build）、`e2e`（默认 Go）、`zero-storage-go`
   （strace Go 二进制）与 Go 容器审计；`playwright.config.ts` 默认信令就是 Go 二进制；Node 相关 job 删除。
8. **阶段 2 也由 Go 承载**：管理权移交（管理员离线 60 s 后移交给最早加入的在线成员）在 Go 服务端实现
   （docs/02 §11.2），不改变信令消息。

## 关键实现对齐点（以 Node 实现为事实源）

| 方面 | 对齐内容 |
|---|---|
| WebSocket | `/v1/ws`、JSON 文本帧、64 KiB 上限、`v` 必须为 2（任意消息类型）否则 `VERSION_MISMATCH` + 关闭 1008 |
| 消息 | `hello/create/join/approve/deny/remove/signal/profile/heartbeat/close` 与全部 S→C 消息字段、错误码、错误文案逐字一致 |
| 房间 | 管理员 + 成员；pending 不入 `members`；`MAX_MEMBERS` 计入 pending+joined+offline；管理员离线保留到 30 min TTL；成员离线 60 s 后移除并只向管理员发 `member_left` |
| 昵称 | 1–16 码点、去控制字符、按加入顺序去重 `-2/-3`、**每次快照重算**（移除后重新编号）、`profile` 限频 10/60 s |
| 短码 | 6 位、10 min、单次使用、`join.roomId` 可直接传码、管理员重连带回短码 |
| 限流 | 按 IP 内存固定窗口 120/60 s（`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` 测试逃生口） |
| 静态 | `index.html` 内存缓存、任意缺失路径回退 SPA、`assets/*` immutable 缓存、CSP/Referrer-Policy/nosniff/Permissions-Policy 逐字节一致、405/400/404 行为一致 |
| TURN 凭据 | `username=<expiry>:<memberId>`、`credential=base64(HMAC-SHA1(secret, username))`、TTL 3600、仅在 `created`/`join_ok` 按需下发 |
| 入口 | `HOST` 默认 127.0.0.1、`PORT` 默认 8788（与 Node `dev.ts` 入口一致；`server.ts` 的 8787 只是库默认值） |

## 与 Node 的已知差异（均为有意为之，已写入文档）

1. 内嵌 TURN 需要 `TURN_EXTERNAL_IP`（Node 只签发凭据、由外部 coturn 负责通告地址）；缺失时启动失败。
2. TURN 日志完全丢弃（Node 由 coturn 写 tmpfs）；3478 被占用时启动失败（Node 没有内嵌 TURN）。
3. 裸二进制默认只监听回环（与入口脚本一致），容器/PM2 显式设置 `HOST=0.0.0.0`。
4. `Start()` 不保证幂等、连接级发送队列有 64 帧上限（自我保护），均为无调用方/安全阀行为。

## 验证

- Go 单测 93 个、语句覆盖率 85.2%、`-race` 干净；`gofmt`/`go vet` 干净。
- `E2E_SERVER=go pnpm e2e` → 20 passed / 1 skipped（与 Node 基线一致）；内嵌 TURN 的 AC2 relay-only 1 passed。
- 独立 parity 审查（Node vs Go，只读）：无 blocker；修复 TURN 门禁、原始路径、`.gitkeep`、panic 恢复、
  profile 哨兵等 8 项差异。
- 零存储：`tests/audit/zero-storage.sh --go` RESULT PASS（0 写盘、stdout 1 行、无 roomId/码/昵称）。
- 生产（v0.2.0，2026-11-27）：静态 Go 二进制、PM2 内存 ~5–11 MB、`turn=on` 监听 3478、coturn 已停用；
  AC10 双向 10 MB 与 AC2 relay-only 10 MB 均通过。详见 `docs/06-acceptance.md`。

## 后果

- **运维面减半**：一个进程、无 Node 运行时、无独立 coturn；内存从 ~65 MB 降到 ~5–11 MB；二进制 10.4 MB
  （旧 Node SEA 123 MB）。
- **协议与客户端零改动**：客户端（含已发布的壳）不需要升级即可连新服务端。
- **失去 Node 生态与测试**：`packages/signaling` 的 TypeScript 单测随实现删除；语义保障转移到 Go 单测 +
  parity 审查 + 全量 e2e + 零存储审计。
- **回滚路径**：部署旧 release（`v0.1.0`，Node tarball）并 `systemctl enable --now coturn`；仓库不再保留
  Node 源码，因此不能从 master 重建旧版本，只能依赖已发布的 release 资产。
- **新风险**：Go 实现与 pion/turn 的长期维护依赖上游；内嵌 TURN 的端口/防火墙要求与 coturn 相同
  （3478 tcp+udp、49160–49200/udp），部署时不能同时跑 coturn。
