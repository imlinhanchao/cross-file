# CrossFile 自托管指南（Go 单二进制）

> 目标：自己的域名上跑一套 CrossFile，文件仍然只在两台设备之间端到端加密直传，服务器**不存一个字节**。
> 代码位置：`apps/signaling-go/`（**唯一**信令实现：一个静态二进制，进程内提供网页 + `/v1/ws` + TURN）、
> `infra/`（Docker 镜像、compose、反代示例）、`tests/audit/`（零存储审计）。
> 设计与验收依据：`docs/01-design.md` §5/§8、`docs/02-protocol.md` §6.6/§6.7/§7、`docs/03-roadmap.md` M4。
>
> 服务器上只跑**一个 Go 二进制**：没有 Node、没有单独的 coturn、没有数据库/Redis/持久卷。生产实例
> `https://file.time-pack.com` 从 v0.2.0 起是 Go 单二进制。

---

## 1. 前置条件

| 依赖           | 版本                                | 说明                                                                                             |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Docker Engine  | 24+                                 | 需要 `docker compose` 插件；不用 Docker 也可以直接跑二进制（见 §12）                             |
| 一台公网主机   | 1 vCPU / 512MB 起                   | 信令只占几十 MB；中继流量走进程内 TURN，按带宽买                                                 |
| 域名 + 证书    | —                                   | 反代用 Caddy 自动签发；TURN 用 `turn.<域名>:3478`（无 TLS 时浏览器同源 HTTPS 页面仍可连，见 §7） |
| 开放端口       | 3478/udp、3478/tcp、49160–49200/udp | 内嵌 TURN 的直接监听与 relay 端口段；有防火墙/安全组要同步放行                                   |
| 可选：`strace` | —                                   | 只为零存储审计的本机模式（`tests/audit/zero-storage.sh`）需要，容器模式不需要                     |

自托管**不需要**数据库、Redis、对象存储、持久卷。容器以只读根文件系统 + distroless 非 root 用户运行，
进程只输出一行启动日志，不写盘、不落访问日志。

---

## 2. 配置 `.env`

```bash
cp infra/.env.example infra/.env
openssl rand -hex 32        # 生成 TURN_SECRET
$EDITOR infra/.env
```

最小可用配置（把域名/IP 换成你自己的）：

```ini
TURN_SECRET=<openssl rand -hex 32 的输出>
TURN_URIS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_EXTERNAL_IP=203.0.113.10
PUBLIC_HOST=room.example.com

SIGNAL_PORT=8788
TURN_PORT=3478
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
```

要点：

- `TURN_SECRET` 用于 `HMAC-SHA1(secret, "<expiry>:<memberId>")` 签发临时凭据，同时被进程内 TURN 校验；**不需要**再起 coturn。
- 内嵌 TURN **只在 `TURN_URIS` 非空且 `TURN_SECRET` 非空时启动**。只配 `TURN_SECRET` 不配 `TURN_URIS` = 不启动 TURN（只能直连），不会启动后失败。
- `TURN_URIS` 是**下发给浏览器**的地址，写公网域名/IP，不要写 `127.0.0.1`（除非浏览器也在同一台机器上做本地联调）。
- `TURN_EXTERNAL_IP` 是 TURN 通告给浏览器的 relay candidate 地址：**启用 TURN 时必填**，缺省则启动失败；公网 VPS 填公网 IPv4，本机两个浏览器联调填 `127.0.0.1`，手机连同 Wi-Fi 联调填宿主机局域网 IP。
- `SIGNAL_PORT` 是**宿主机**发布端口（默认 8788，与仓库开发默认 `pnpm dev:signal`/Vite 代理一致），容器内固定监听 8787；只改这里不需要动别处。
- `TURN_PORT`/`TURN_MIN_PORT`/`TURN_MAX_PORT` 控制内嵌 TURN 的监听端口与 relay 端口段；compose 把同样的端口发布到宿主机，所以要同时放行防火墙。
- `.env` 已被根 `.gitignore` 忽略，不会误提交；不要把它放进镜像（`Dockerfile.dockerignore` 也排除了）。

---

## 3. 起停

```bash
# 构建 + 启动（首次构建会装前端依赖、构建 Vite、编译 Go，视网络约 2–5 分钟；之后走缓存）
docker compose -f infra/docker-compose.yml up -d --build

# 状态 / 日志
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml logs signaling    # 只应有一行启动日志
docker compose -f infra/docker-compose.yml down -v

# 升级（会切断进行中的传输，低峰期做）
docker compose -f infra/docker-compose.yml up -d --build --force-recreate signaling
```

镜像内是**单个 Go 二进制**：一个端口同时提供页面、静态资源、`/v1/ws` 与 TURN。验收：

```bash
# 1. 进程只输出一行启动信息（没有访问日志）
docker compose -f infra/docker-compose.yml logs signaling

# 2. 页面与 SPA 回退
curl -fsS http://127.0.0.1:8788/ | grep -q '<div id="root">'
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/r/abcdefghijklmnopqrstuvwxyz   # 200

# 3. 用仓库里的真实会话客户端连一次（create → join → approve → signal → close）
node --import tsx tests/audit/signal-client.mts ws://127.0.0.1:8788/v1/ws
# 期望最后一行：CLIENT PASS
```

> 若宿主机 8788 已被 `pnpm dev` 占用，用 `SIGNAL_PORT=18788` 只改宿主机映射端口，容器内始终监听 8787；上面验收命令里的端口要同步改。
> 运行时镜像基于 distroless（没有 shell/curl），所以 compose 不配 healthcheck；就绪判断看 `/v1/ws` 是否能升级成功。
> 升级时不需要安装任何运行时；服务器上也不需要 Node（除非你用 PM2 管理进程，见 §11/§12）。

---

## 4. 如何确认 TURN 真的生效

信令服务器只会“按需下发”TURN 凭据；浏览器是否真的走中继，要看 ICE 选出的 candidate pair。

### 4.1 手工验证（chrome://webrtc-internals）

1. 打开 `chrome://webrtc-internals`，保持这个标签页，再开一个 CrossFile 页面开始传输。
2. 在 webrtc-internals 左侧选中对应的 `RTCPeerConnection`。
3. 看 **ICE candidate pairs**：
   - `succeeded` 且 `nominated` 的那一对，本地/远端 candidate 类型是 `relay` → 正在走 TURN；
   - `srflx`/`host` → 直连或打洞，不是中继。
4. 看 **selected candidate pair** 的 `localCandidateId`/`remoteCandidateId`，在 candidates 列表里核对类型。
5. 应用侧对照点：`getStats()` 里的选中候选对映射成 UI 标签（「局域网直连 / 直连 / 中继」，docs/02 §6.6）。

relay candidate 的端口必须落在 `TURN_MIN_PORT`–`TURN_MAX_PORT` 段内（默认 49160–49200），地址必须等于
`TURN_EXTERNAL_IP`。如果 candidate 只有 host/srflx，说明 TURN 没启动（检查 `TURN_URIS`/`TURN_SECRET` 是否都非空、
`TURN_EXTERNAL_IP` 是否设置）或端口没放行。

### 4.2 强制走中继（`?relay=1`）

页面支持 `?relay=1`（controller 读取后把 `iceTransportPolicy` 设为 `relay`，e2e 的 AC2 用例就是这么跑的）：

```text
https://<domain>/?relay=1
```

此时若传输能完成且 webrtc-internals 里 candidate 类型是 `relay`，说明内嵌 TURN、凭据和时间戳都对。
也可以临时把 `iceServers` 只留 turn 来验证。

### 4.3 中继链路自检（不用浏览器，仓库 e2e 已覆盖）

内嵌 TURN 不需要 coturn，也不需要用 `turnutils_uclient` 之类的外部工具。仓库的 AC2 用例会起一个真实的
Go 信令进程（含内嵌 TURN），用两个浏览器强制 relay 完成一次传输并断言两边路径标签：

```bash
E2E_RELAY=1 \
TURN_SECRET=... \
TURN_URIS='turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp' \
pnpm exec playwright test tests/e2e/ac2-relay.spec.ts
```

`TURN_EXTERNAL_IP` 默认被测试 harness 设为 `127.0.0.1`（浏览器同机）。生产环境请按 §2 设置成公网 IPv4。

---

## 5. 端口与防火墙

一个进程同时服务网页/信令/TURN，对外端口：

| 端口        | 协议      | 用途                                                              | 对外             |
| ----------- | --------- | ----------------------------------------------------------------- | ---------------- |
| 443         | tcp       | 反代（静态站 + `wss://…/v1/ws`）                                  | 必须             |
| 8788        | tcp       | signaling 宿主机发布端口（容器内 8787；默认只在反代后面）         | 建议只对反代开放 |
| 3478        | udp + tcp | TURN 监听（进程内）                                               | 必须             |
| 49160–49200 | udp       | TURN relay 分配段（`TURN_MIN_PORT`–`TURN_MAX_PORT`）              | 必须             |
| 5173        | tcp       | 仅开发：Vite dev server                                           | 不要暴露公网     |

> **内嵌 TURN 直接绑定 3478/udp+tcp，同一台机器上不能再运行其他 TURN 服务（如 coturn）**，否则 Go 进程
> 启动会因 `EADDRINUSE` 失败、健康检查失败。

防火墙示例（ufw）：

```bash
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
```

云厂商安全组同理。`SIGNAL_BIND=127.0.0.1` 时宿主机 8788 不对外，只有本机反代能连；若 signaling 跑在另一台机器，改成内网地址并在反代里指过去。

---

## 6. 反代与 HTTPS

浏览器要求 WebRTC 与 `navigator.clipboard` 等在安全上下文（HTTPS）下工作，且 signaling 必须与页面同源（`wss://<同源>/v1/ws`）。

生产：示例见 `infra/deploy/Caddyfile.example`。核心是三件事：

1. `/v1/ws` 反代到 `127.0.0.1:8788`（Caddy 的 `reverse_proxy` 自动处理 WebSocket Upgrade；对应 compose 的 `SIGNAL_PORT`）；
2. 其余路径也反代到同一端口——**Go 二进制自己托管页面**（内嵌 Web 应用），不需要额外的静态站；
3. 安全响应头由 Go 进程自带（HSTS 由反代补）：`Referrer-Policy: no-referrer`、严格 CSP、`X-Content-Type-Options: nosniff`、
   `X-Frame-Options: SAMEORIGIN`、`Permissions-Policy`。

```bash
# 本机开发：已有的反代把 https://room.net.time-pack.com -> 127.0.0.1:5173，
# Vite 自己再把 /v1/ws 代理到 ws://127.0.0.1:8788（见 apps/web/vite.config.ts）。
pnpm dev
# 浏览器打开 https://room.net.time-pack.com
```

生产不要用 Vite dev server；反代直接指到 Go 进程的 8788 即可。

---

## 7. 隐私边界：服务器能看到什么、看不到什么

对外文案已定稿（`docs/01-design.md` §5 原文）：**服务器不存一个字节**，文件端到端加密，密钥只在二维码/链接里。

| 服务器**看得到**                                             | 服务器**看不到**                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 双方的 IP 地址（只作为内存里的限频 key，不落房间、不落日志） | 文件内容（AES-GCM 加密，密钥从不上行）                              |
| 房间存在的时间、房间/成员数量（内存 Map，结束即清）          | 文件名、大小之外的元数据（manifest 只在发送端与接收端的加密通道里） |
| 经 TURN 中继的流量字节数（进程内转发密文，无法解密）         | 聊天记录、历史、账号（没有这些概念）                                |
| 连接时的 TLS/WS 元信息（反代层）                             | 访问日志、分析埋点（signaling 只输出一行启动日志）                  |

实现层面（`docs/02-protocol.md` §7）：房间/peer/限频计数全在进程内存，无数据库、无 Redis、无写文件；日志只允许
error 级且不含 IP/UA/roomId/显示名；无 cookie、无指纹、无第三方统计；容器只读根文件系统、非 root、无 volume；
崩溃重启即丢全部房间（设计如此）。TURN 是仅有的“能看到流量大小”的组件。

> 诚实说明：中继流量经过你的服务器，运营商/云厂商仍能看到加密流量的存在与大小；TURN 的合法合规责任（docs/03 R8）由自托管者承担，请自备 ToS 与关停机制。

---

## 8. 零存储审计

`tests/audit/zero-storage.sh` 有两种模式，都不需要 sudo。默认模式审计 Go 二进制。

### 8.1 本机进程 + strace（默认）

```bash
pnpm install                                   # 需要仓库依赖（tsx 用于驱动客户端）
bash tests/audit/zero-storage.sh               # 默认 AUDIT_PORT=18787
AUDIT_PORT=18888 KEEP_TMP=1 bash tests/audit/zero-storage.sh
SKIP_BUILD=1 bash tests/audit/zero-storage.sh  # 复用已构建的 apps/signaling-go/bin/crossfile-signaling
```

它做的事：

1. 用 `SKIP_WEB=1 bash apps/signaling-go/build.sh` 构建 Go 二进制；
2. 用 `strace -f -e trace=openat,openat2,write` 包住它，监听 18787；
3. 用 `tests/audit/signal-client.mts` 完成真实 8 步 v2 会话（create → 2×join/approve → members 广播 → profile 改名广播 → admin→A / A→admin / A→B → close）；
4. 用 `tests/audit/analyze-trace.mjs` 断言：
   - 没有任何 `O_WRONLY/O_RDWR/O_CREAT/O_TRUNC/O_APPEND/O_TMPFILE` 的文件 open（排除 `/dev`、`/proc`、`/sys`）；
   - 没有 `write(2)` 落到“以写方式打开的文件 fd”（stdout/stderr/socket 不算）；
   - 没有任何数据库痕迹（`*.db` / sqlite / leveldb / redis / postgres）；
   - 服务端 stdout 只有一行启动日志，无 access log，且**不含本次会话的 roomId / 6 位码 / 显示名**；
   - 客户端会话确实成功，且进程工作目录保持为空。

### 8.2 容器只读模式（Go 镜像）

```bash
bash tests/audit/zero-storage.sh --container
```

它会 `docker compose build/up` 一个独立项目（`crossfile-audit`）；通过 `infra/docker-compose.audit.yml` 叠加在生产 compose 之上，
只发布信令端口（审计中 TURN 关闭，不需要也不发布 3478/relay 端口），只读 rootfs/非 root/capability 等仍是生产配置。然后断言：

- `HostConfig.ReadonlyRootfs=true`、`Config.User` 非 root（65532:65532）、`Mounts=0`、`Binds=null`、`CapDrop=ALL`、`no-new-privileges`；
- `/v1/ws` 能完成 WebSocket 升级（distroless 镜像没有 healthcheck/shell）；
- 同一 8 步真实会话 `CLIENT PASS`；
- `docker logs` 只有一行启动日志；
- `docker diff` 为空——进程运行期间容器文件系统没有任何变化（零写盘的容器侧证据）；
- 最后 `docker compose down -v` 干净退出。

FAIL 都带 `[EVIDENCE]` 证据行并以退出码 1 结束。

> 注意：`strace` 只跟踪自己的子进程，普通用户即可，无需 `sudo`/`ptrace_scope` 调整。若你的发行版禁用了非特权 ptrace，本机模式会提示用 `--container`。

---

## 9. 验收记录

Go 单二进制上线生产（v0.2.0）的完整验收证据在 `docs/06-acceptance.md`「Go 单二进制后端」（由 Lead 维护）：
`pnpm gate` 全绿、`go test` 93 个测试 / 85.2% 覆盖 / `-race` 干净、全量 e2e 20 passed / 1 skipped、内嵌 TURN 的
AC2 relay 1 passed、生产 AC10 双向 10 MB 与 AC2 relay-only 10 MB 通过、零存储审计 PASS。

本机按本文件命令实跑的零存储审计（默认 Go 模式，节选）：

容器模式（`SKIP_BUILD=1 bash tests/audit/zero-storage.sh --container`）同上：只读 rootfs、非 root 65532、无 volume、
CapDrop ALL、no-new-privileges、`/v1/ws` 升级成功、同一 8 步会话 `CLIENT PASS`、`docker logs` 恰一行、
`docker diff` 为空、`down -v` 干净 → `RESULT PASS`。

```console
$ bash tests/audit/zero-storage.sh
== Zero-storage audit (Go binary, strace) ==
[PASS] Go signaling binary built (SKIP_WEB=1)
[EVIDENCE] server stdout: [crossfile-signaling] listening on ws://127.0.0.1:18787/v1/ws turn=off
[PASS] signaling process opened no writable file (no O_WRONLY/O_RDWR/O_CREAT/O_TRUNC/O_APPEND/O_TMPFILE)
[PASS] no write(2) reached a file opened for writing (1 write(s) to stdout/stderr, 23 to sockets/pipes)
[PASS] no database file path was opened (no *.db / sqlite / leveldb / redis / postgres artefacts)
[PASS] server stdout has exactly 1 line, the startup line: [crossfile-signaling] listening on ws://127.0.0.1:18787/v1/ws turn=off
[PASS] no HTTP/access-log lines on stdout
[PASS] server stdout contains none of the 4 client-visible secret(s) (roomId/code/display names)
[PASS] real signaling session completed through the audited process (8 steps, CLIENT PASS)
[PASS] process working directory stayed empty
RESULT PASS (zero-storage audit, local)
```

---

## 10. 常见故障

| 现象                                             | 原因 / 处理                                                                                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启动即失败 / 容器反复重启                        | `TURN_SECRET` 或 `TURN_URIS` 配了但 `TURN_EXTERNAL_IP` 缺失；或 3478 被其他 TURN 服务占用（`EADDRINUSE`）。看 `docker compose logs signaling`（应只有一行启动日志或一行 config 错误）。 |
| 信令能连但页面 404                               | 镜像构建时 Vite 产物没有 embed 进去（构建阶段失败被忽略？）；重新 `--build` 并确认构建阶段 `pnpm --filter @crossfile/web build` 成功。                                                                                   |
| 页面能连信令但传输极慢/总是失败                   | TURN 不可达。检查 3478/udp+tcp、49160–49200/udp 的安全组；`TURN_URIS` 的域名解析到公网 IP；webrtc-internals 看 candidate 是否只有 host/srflx。                                                                            |
| relay candidate 是 `relay` 但连不上              | `TURN_EXTERNAL_IP` 填成了内网地址（应为公网 IPv4/LAN IP），或 relay 端口段未放行。                                                                                                                                       |
| webrtc-internals 里 ICE 一直 `checking`          | 凭据过期（TTL 1h）或浏览器与服务端时间差过大；核对 `/v1/ws` 是否同源 wss、反代是否透传 Upgrade。                                                                                                                         |
| 服务器 3478 已有服务占用                         | 停掉占用它的服务（如 `systemctl disable --now coturn`）或改 `TURN_PORT`/`TURN_LISTEN_PORT`（同时改 `TURN_URIS` 端口）与 compose 发布端口。                                                                                     |
| `docker compose build` 卡在 `pnpm install`       | 主机访问 npm registry 慢/被墙。给 Docker daemon 配代理（`/etc/docker/daemon.json` 的 `proxies`）。                                                                                                                       |
| `permission denied` 写文件/挂载                  | 设计如此：只读根文件系统 + 非 root + 无 volume。别加 `volumes`，需要持久化的东西不应该存在于这套部署里。                                                                                                                |
| 审计本机模式报 `strace is not installed`         | `apt install strace`；或改用 `--container`。                                                                                                                                                                            |
| 审计 `--container` 报端口占用/构建失败           | `AUDIT_PORT=18888 bash tests/audit/zero-storage.sh --container`；或先 `docker compose -f infra/docker-compose.yml build signaling` 再 `SKIP_BUILD=1 … --container`。                                                      |
| 反代 502 / WebSocket 连不上                      | 反代没有转发 Upgrade 头，或 `/v1/ws` 指到了错误端口；Caddy 的 `reverse_proxy` 默认支持 Upgrade，Nginx 需要手写 `proxy_set_header Upgrade $http_upgrade` 等。                                                            |
| 部署后 `pm2 ls` 显示 errored                     | 看 `pm2 logs crossfile-signaling`；常见是 `shared/.env` 缺少 `TURN_EXTERNAL_IP` 或 3478 被占。                                                                                                                            |

---

## 11. GitHub Actions 自动部署（无 Docker：构建 → scp → PM2）

适用于不用 Docker、用 PM2 守护进程的服务器。发布与部署拆成两个 workflow：

**`.github/workflows/release.yml`（打包）**：push tag `v*`（或手动 `workflow_dispatch`）触发；跑门禁
（lint/typecheck/单测/Go 测试/e2e/零存储）并校验 tag 与 6 个 manifest 的版本一致，然后构建全部产物：
服务器 tarball（**Go 二进制** + `ecosystem.config.cjs` + `VERSION`，x64/arm64）、裸二进制、Linux AppImage、
Windows/macOS Tauri（无证书）、Android APK（release keystore 签名），最后**自动发布 release** 并显式 dispatch `deploy`
（GITHUB_TOKEN 不会为它创建的 release 发 `release: published`，所以用 `gh workflow run`；见 `docs/release.md` §1）。
产物清单见 `docs/release.md`。

**`.github/workflows/deploy.yml`（部署）**：被 release dispatch、人工发布 release（`release: published`）或手动
`workflow_dispatch` 触发。它**不重新构建**，而是用 `gh release download` 下载该 release 的 server tarball、校验
`SHA256SUMS`，然后：

1. SSH 建目录（`releases/<tag>`、`shared/`、`logs/`），检查 `shared/.env` 与 `pm2` 是否存在；
2. `scp` 上传 tarball → 解包 → 加载 `shared/.env` → `pm2 delete` + `pm2 start releases/<tag>/ecosystem.config.cjs --update-env`
   → `pm2 save` → 轮询 `http://127.0.0.1:${PORT}/`（默认 8788）直到 200；
3. 更新 `current` 软链 → 可选 `PUBLIC_BASE_URL` 公网 smoke → 只保留最近 5 个 release。

这样「发布的版本 = 线上跑的版本」；回滚只需重新部署上一个 Go release tag（手动跑 `deploy` 并输入旧 tag）。
**服务器上的 Node 只用于运行 PM2 本身**：应用是静态 Go 二进制，不需要 Node 运行时；也可以不用 PM2，改 systemd（§12.3）。

### 服务器一次性准备（只需要一次）

```bash
# 1) PM2（Node 只用来跑 PM2，不跑应用）；或改用 systemd
node -v                    # 需要 v22+（仅 PM2 需要）
npm i -g pm2
sudo env PATH=$PATH:$(dirname "$(which node)") pm2 startup systemd -u deploy --hp /home/deploy

# 2) 部署目录
sudo mkdir -p /srv/crossfile/{releases,shared,logs}
sudo chown -R deploy:deploy /srv/crossfile

# 3) 配置（只存在服务器上，不进仓库）
sudo -u deploy nano /srv/crossfile/shared/.env
```

`/srv/crossfile/shared/.env` 示例（工作流会 `source` 它，`ecosystem.config.cjs` 把变量透传给二进制）：

```ini
TURN_SECRET=<openssl rand -hex 32>
TURN_URIS=turn:room.example.com:3478?transport=udp,turn:room.example.com:3478?transport=tcp
TURN_EXTERNAL_IP=<公网 IPv4>
PUBLIC_HOST=room.example.com
PORT=8788
HOST=127.0.0.1
# TURN_LISTEN_PORT=3478
# TURN_MIN_PORT=49160
# TURN_MAX_PORT=49200
# 成员上限（不含管理员）：自托管默认 4；官方实例建议 2（docs/01 D6）
# MAX_MEMBERS=2
```

反代（Caddy/nginx）指向 `127.0.0.1:8788`，模板见 `infra/deploy/Caddyfile.example`。

### 需要配置的 GitHub Secrets

| Secret                                              | 必填   | 说明                                                       |
| --------------------------------------------------- | ------ | ---------------------------------------------------------- |
| `DEPLOY_HOST`                                       | ✅     | 服务器域名或 IP                                            |
| `DEPLOY_USER`                                       | ✅     | SSH 用户（拥有 `/srv/crossfile`）                          |
| `DEPLOY_SSH_KEY`                                    | ✅     | 该用户的私钥（ed25519 推荐）                               |
| `DEPLOY_PATH`                                       | ✅     | 部署根目录，例如 `/srv/crossfile`                          |
| `DEPLOY_PORT`                                       | 可选   | SSH 端口，默认 22                                          |
| `PUBLIC_BASE_URL`                                   | 可选   | 例如 `https://room.example.com`，设置后做公网 smoke test   |
| `ANDROID_*`（4 个）                                 | ✅     | 只用于 Android job，见 `docs/release.md` §4                |

### 回滚

```bash
ssh deploy@server
export PM2_LOG_DIR=/srv/crossfile/logs
set -a; . /srv/crossfile/shared/.env; set +a
pm2 start /srv/crossfile/releases/<旧 tag>/ecosystem.config.cjs --update-env
pm2 save
```

（或手动跑 `deploy` 工作流并输入旧 tag。每个 release 的 tarball 自带自己的 `ecosystem.config.cjs`，
回滚就是部署上一个 Go release tag。）

### 运维提示

- 日志：`pm2 logs crossfile-signaling`，文件在 `$DEPLOY_PATH/logs/signaling.{out,err}.log`；
  需要轮转时 `pm2 install pm2-logrotate`。
- PM2 开机自启：`pm2 startup` 一次，之后每次部署工作流会 `pm2 save`。
- 部署会重启信令（房间在内存里），进行中的传输会中断，尽量避开高峰。
- 如果服务器其实有 Docker，用 `infra/docker-compose.yml` 的容器方式（见本文件上面章节）。

---

## 12. 不用 Docker 的单二进制部署（PM2 或 systemd）

### 12.1 拿到二进制

```bash
# A. 从 GitHub Release 下载（推荐；x64 / arm64 都有 tarball 和裸二进制）
gh release download v0.2.0 --pattern 'crossfile-signaling-*-linux-x64.tar.gz' --dir /tmp/cf
mkdir -p /srv/crossfile
tar -xzf /tmp/cf/crossfile-signaling-*-linux-x64.tar.gz -C /srv/crossfile
chmod 0755 /srv/crossfile/crossfile-signaling

# B. 从源码构建（需要 Go 1.23+ 与 pnpm）
pnpm --filter @crossfile/web build
mkdir -p apps/signaling-go/webdist && cp -r apps/web/dist/. apps/signaling-go/webdist/
SKIP_WEB=1 bash apps/signaling-go/build.sh     # 产物 apps/signaling-go/bin/crossfile-signaling
```

tarball 解开就是三个文件：`crossfile-signaling`（静态二进制，含内嵌网页与 TURN）、`ecosystem.config.cjs`、`VERSION`。

### 12.2 启动（PM2）

```bash
set -a; . /srv/crossfile/shared/.env; set +a
pm2 delete crossfile-signaling 2>/dev/null || true
pm2 start /srv/crossfile/ecosystem.config.cjs --update-env
pm2 save
```

`ecosystem.config.cjs` 的关键项：`interpreter: "none"`（直接 exec 二进制，不经过 Node）、`cwd: __dirname`、
`env` 透传 `HOST`/`PORT`/`MAX_MEMBERS`/`TURN_*`（空值视为未设置）。

> 也可以不用 PM2：`deploy.yml` 支持 `DEPLOY_MODE=systemd`（自动生成并重启 systemd unit，省掉 PM2 守护进程约 80 MB 内存，日志进 journal）。下面的 systemd 单元示例与 CI 生成的内容等价。

### 12.3 启动（systemd，不装 PM2）

```ini
# /etc/systemd/system/crossfile.service
[Unit]
Description=CrossFile signaling (Go single binary)
After=network-online.target

[Service]
User=crossfile
# 内嵌 TURN 用 netlink 枚举网卡：加固时不要屏蔽 AF_NETLINK
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
WorkingDirectory=/srv/crossfile
EnvironmentFile=/srv/crossfile/shared/.env
ExecStart=/srv/crossfile/crossfile-signaling
Restart=always
RestartSec=2
# 进程本身不写盘，只读文件系统友好
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now crossfile
```

### 12.4 验收

```bash
# 1. 单进程：网页、/v1/ws、TURN 都在同一个 PID
curl -fsS http://127.0.0.1:8788/ | grep -q '<div id="root">'
curl -fsS -o /dev/null http://127.0.0.1:8788/r/abcdefghijklmnopqrstuvwxyz    # SPA 回退
node --import tsx tests/audit/signal-client.mts ws://127.0.0.1:8788/v1/ws     # 期望 CLIENT PASS
pm2 logs crossfile-signaling --lines 5 --nostream                            # 只有一行启动日志

# 2. 零存储（Go 二进制）
bash tests/audit/zero-storage.sh
```

TURN 是否真的生效按 §4 的方法验证；区别只是 TURN 就在同一个进程里，`TURN_EXTERNAL_IP` / `TURN_MIN_PORT` /
`TURN_MAX_PORT` 直接生效。

### 12.5 回滚

- **回滚到上一个 Go release**：`deploy` 工作流输入旧 tag，或服务器上
  `pm2 start releases/<旧 tag>/ecosystem.config.cjs --update-env && pm2 save`。
- 回滚使用旧 tag 的 tarball（自带该版本的 `ecosystem.config.cjs`，`interpreter: "none"` 直接跑二进制）；
  `deploy.yml` 不需要区分版本。TURN 在同一个二进制里，回滚不涉及外部服务。
