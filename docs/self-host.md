# CrossFile 自托管指南（signaling + coturn）

> 目标：自己的域名上跑一套 CrossFile，文件仍然只在两台设备之间端到端加密直传，服务器**不存一个字节**。
> 代码位置：`infra/`（compose、镜像、反代示例）、`tests/audit/`（零存储审计）。
> 设计与验收依据：`docs/01-design.md` §5/§8、`docs/02-protocol.md` §6.6/§6.7/§7、`docs/03-roadmap.md` M4。

---

## 1. 前置条件

| 依赖           | 版本                                | 说明                                                                                             |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Docker Engine  | 24+                                 | 需要 `docker compose` 插件（v2.24+，用到了 `!reset` 的 override 可选）                           |
| 一台公网主机   | 1 vCPU / 512MB 起                   | signaling 只占几十 MB；中继流量走 coturn，按带宽买                                               |
| 域名 + 证书    | —                                   | 反代用 Caddy 自动签发；TURN 用 `turn.<域名>:3478`（无 TLS 时浏览器同源 HTTPS 页面仍可连，见 §7） |
| 开放端口       | 3478/udp、3478/tcp、49160–49200/udp | 中继端口段可在 `.env` 改；有防火墙/安全组要同步放行                                              |
| 可选：`strace` | —                                   | 只为零存储审计（`tests/audit/zero-storage.sh`）需要，Docker 模式不需要                           |

自托管**不需要**数据库、Redis、对象存储、持久卷。signaling 容器以只读根文件系统 + 非 root 用户运行。

---

## 2. 配置 `.env`

```bash
cp infra/.env.example infra/.env
openssl rand -hex 32        # 生成 TURN_SECRET（同一份给 signaling 与 coturn）
$EDITOR infra/.env
```

最小可用配置（把域名换成你自己的）：

```ini
TURN_SECRET=<openssl rand -hex 32 的输出>
TURN_URIS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
PUBLIC_HOST=room.example.com
TURN_EXTERNAL_IP=203.0.113.10

SIGNAL_PORT=8788
COTURN_MIN_PORT=49160
COTURN_MAX_PORT=49200
```

要点：

- `TURN_SECRET` 必填。signaling 用它按 `HMAC-SHA1(secret, "<expiry>:<peerId>")` 签发临时凭据，coturn 用 `static-auth-secret` 校验；两边必须一致，`compose` 不会替你生成。
- `TURN_URIS` 是**下发给浏览器**的地址，写公网域名/IP，不要写 `127.0.0.1`（除非浏览器也在同一台机器上做本地联调）。
- `TURN_EXTERNAL_IP` 是 **coturn 通告给浏览器的 relay candidate 地址**。Docker 桥接网络里 coturn 看到的是容器内网 IP（172.x），必须显式告诉它宿主机地址：公网 VPS 填公网 IPv4；本机两个浏览器联调填 `127.0.0.1`；手机连同 Wi-Fi 联调填宿主机局域网 IP。
- `SIGNAL_PORT` 是**宿主机**发布端口（默认 8788，与仓库开发默认 `pnpm dev:signal`/Vite 代理一致），容器内固定监听 8787；只改这里不需要动健康检查。
- 端口段 `COTURN_MIN/MAX_PORT` 同时控制 coturn 的 `--min-port/--max-port` 和 compose 的端口映射，改一处即可，但要和防火墙同步。
- `.env` 已被根 `.gitignore` 忽略，不会误提交；不要把它放进镜像（`Dockerfile.dockerignore` 也排除了）。

---

## 3. 起停

```bash
# 构建 + 启动（首次构建会联网装依赖并 esbuild 打包，视网络约 2–5 分钟；之后走缓存）
docker compose -f infra/docker-compose.yml up -d --build

# 状态 / 日志
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml logs signaling    # 只应有一行启动日志
docker compose -f infra/docker-compose.yml logs coturn

# 停止并清理
docker compose -f infra/docker-compose.yml down -v
```

验收（这两个命令必须实际跑过，输出见 §9）：

```bash
# 1. signaling 进程只输出一行启动信息，且健康检查为 healthy
docker compose -f infra/docker-compose.yml logs signaling

# 2. 用仓库里的真实会话客户端连一次（create → join → approve → signal → close）
node --import tsx tests/audit/signal-client.mts ws://127.0.0.1:8788/v1/ws
# 期望最后一行：CLIENT PASS
```

> 若宿主机 8788 已被 `pnpm dev:signal` 占用，用 `SIGNAL_PORT=18788` 只改宿主机映射端口，容器内始终监听 8787；下面验收命令里的端口要同步改。本次验收就在 18787 上跑（见 §9）。
> coturn 镜像固定在 `coturn/coturn:4.19.2-alpine`，与老文档的差异（`--no-cli`/`--no-dtls` 已删除）见 §4.3。

如果你想在**本机**验证中继路径（浏览器和 coturn 在同一台机器），叠加 host 网络 override：

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.hostnet.yml up -d --build
```

原因：桥接网络下 coturn 下发的 relay candidate 是容器内网地址，宿主机浏览器连不上；host 网络让 candidate 带宿主机地址。仅在 Linux 上需要，生产公网服务器用默认 compose 即可（默认 compose 要靠 `TURN_EXTERNAL_IP` 得到同样效果）。若用手机连接，把 `TURN_EXTERNAL_IP` 设成宿主机的局域网 IP。

### 镜像里为什么不是 `tsx` 直接跑 `dev.ts`

`infra/signaling/Dockerfile` 在构建阶段用 `pnpm install --filter @crossfile/signaling...` 装依赖，然后用 `esbuild`（`tsx` 自带的依赖，见 `infra/signaling/build.mjs`）把 `infra/signaling/entry.ts` 打成**单个 `server.cjs`**，运行阶段只 `COPY` 这一个文件、`node server.cjs` 启动。原因有两条，都是 AC8 的硬要求：

1. `tsx` 运行时会把转译结果写到 `$TMPDIR/tsx-<uid>/`，这是信令进程的**真实文件写入**，`strace` 能抓到，审计会 FAIL；
2. 只读根文件系统下 `/tmp` 不可写，`tsx` 会直接启动失败。

`infra/signaling/entry.ts` 与 `packages/signaling/src/dev.ts` 逻辑相同，唯一差别是支持 `HOST` 环境变量（默认 `0.0.0.0`）。`dev.ts` 固定监听 `127.0.0.1`，容器发布端口无法访问，所以生产入口单独放了这一份；后续若把 `HOST` 支持合进 `dev.ts`，可以删掉 `entry.ts`（已报给 Lead，涉及 `packages/**`，本任务不改）。

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
5. 在应用侧还有一个对照点：`getStats()` 里的选中候选对映射成 UI 标签（「局域网直连 / 直连 / 中继」，docs/02 §6.6）。M1 之后会直接显示「中继」，届时无需开 webrtc-internals。

想看 TURN 服务器是否收到分配：`docker compose -f infra/docker-compose.yml logs coturn`。成功中继时会有 allocation 相关日志（日志级别保持最低，只到 stdout，不落盘）。

### 4.2 强制走中继（计划中的测试钩子）

仓库里**尚未实现** `?relay=1` 之类的测试参数（M1 待办）。在那之前，可以用浏览器的 `chrome://flags` 或 DevTools 的 `RTCPeerConnection` 构造参数手工把 `iceTransportPolicy` 设为 `relay`，或临时把 `iceServers` 只留 turn，来验证中继可用：

```js
// DevTools 控制台（页面已加载后，仅用于验证，不写进产品代码）
const orig = window.RTCPeerConnection;
window.RTCPeerConnection = function (config = {}) {
  config.iceTransportPolicy = "relay";
  return new orig(config);
};
```

此时若传输能完成且 webrtc-internals 里 candidate 类型是 `relay`，说明 coturn、凭据和时间戳都对。

### 4.3 中继链路自检（不用浏览器，已实测通过）

分两步：先确认 signaling 下发的凭据格式与 coturn 的 `static-auth-secret` 一致，再让 coturn 自带的
`turnutils_uclient` 用这份凭据做一次真实的 TURN 分配与中继收发。

```bash
# 1) 按 signaling 的公式（packages/signaling/src/turn.ts）生成一份同格式凭据
SECRET=$(grep '^TURN_SECRET=' infra/.env | cut -d= -f2)
EXPIRY=$(( $(date +%s) + 3600 ))
USER_NAME="$EXPIRY:selftest"
PASSWORD=$(printf '%s' "$USER_NAME" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)

# 2) 与 coturn 同机跑 TURN 客户端：-y 客户端互连，-c 不建 RTCP
docker run --rm --network host coturn/coturn:4.19.2-alpine \
  turnutils_uclient -u "$USER_NAME" -w "$PASSWORD" -p 3478 -y -c -n 3 \
  "${TURN_EXTERNAL_IP:-127.0.0.1}"
```

期望输出包含：

```text
INFO allocate response received:
INFO IPv4. Received relay addr: <TURN_EXTERNAL_IP>:49xxx
INFO start_mclient: tot_send_msgs=10, tot_recv_msgs=10
INFO Total lost packets 0 (0.000000%)
```

`relay addr` 的端口必须落在 `COTURN_MIN_PORT`–`COTURN_MAX_PORT` 段内（默认 49160–49200），且地址等于
`TURN_EXTERNAL_IP`。仓库实测还把 signaling 真实下发的 `created.turn` 凭据直接交给同一条命令跑通（见 §9.3），
所以“signaling 签名 == coturn 校验”这条链路已经验证过。

> coturn 4.19 与老文档的两处差异（compose 已适配）：`--no-cli` 已废弃（CLI 默认关闭），`--no-dtls` 已不存在
> （DTLS 默认关闭），继续传会打印 `unrecognized option` 并退出。

---

## 5. 端口与防火墙

| 端口        | 协议      | 用途                                                      | 对外             |
| ----------- | --------- | --------------------------------------------------------- | ---------------- |
| 443         | tcp       | 反代（静态站 + `wss://…/v1/ws`）                          | 必须             |
| 8788        | tcp       | signaling 宿主机发布端口（容器内 8787；默认只在反代后面） | 建议只对反代开放 |
| 3478        | udp + tcp | TURN 监听                                                 | 必须             |
| 49160–49200 | udp       | TURN relay 分配段（`COTURN_MIN_PORT`–`COTURN_MAX_PORT`）  | 必须             |
| 5173        | tcp       | 仅开发：Vite dev server                                   | 不要暴露公网     |

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
2. 其余路径返回 `apps/web/dist` 静态文件（`pnpm --filter @crossfile/web build` 的产物），SPA 用 `try_files {path} /index.html`；
3. 安全响应头：HSTS、`Referrer-Policy: no-referrer`、CSP `default-src 'self'`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`。

```bash
# 本机开发：已有的反代把 https://room.net.time-pack.com -> 127.0.0.1:5173，
# Vite 自己再把 /v1/ws 代理到 ws://127.0.0.1:8788（见 apps/web/vite.config.ts）。
# 因此开发时只需要：
pnpm dev:signal     # 或 docker compose -f infra/docker-compose.yml up -d signaling
pnpm dev:web
# 浏览器打开 https://room.net.time-pack.com
```

生产不要用 Vite dev server；`apps/web/dist` 交给 Caddy/Nginx。

---

## 7. 隐私边界：服务器能看到什么、看不到什么

对外文案已定稿（`docs/01-design.md` §5 原文）：**服务器不存一个字节**，文件端到端加密，密钥只在二维码/链接里。

| 服务器**看得到**                                             | 服务器**看不到**                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 双方的 IP 地址（只作为内存里的限频 key，不落房间、不落日志） | 文件内容（AES-GCM 加密，密钥从不上行）                              |
| 房间存在的时间、房间/成员数量（内存 Map，结束即清）          | 文件名、大小之外的元数据（manifest 只在发送端与接收端的加密通道里） |
| 经 TURN 中继的流量字节数（coturn 转发密文，无法解密）        | 聊天记录、历史、账号（没有这些概念）                                |
| 连接时的 TLS/WS 元信息（反代层）                             | 访问日志、分析埋点（signaling 只输出一行启动日志）                  |

实现层面（`docs/02-protocol.md` §7）：房间/peer/限频计数全在进程内存，无数据库、无 Redis、无写文件；日志只允许 error 级且不含 IP/UA/roomId；无 cookie、无指纹、无第三方统计；signaling 容器只读根文件系统、非 root、无 volume；coturn 不挂持久卷、日志只进 stdout；崩溃重启即丢全部房间（设计如此）。TURN 是仅有的“能看到流量大小”的组件，`--no-multicast-peers` 等限制已在 compose 中开启，且没有 `no-loopback-peers`（本机联调需要 loopback）。

> 诚实说明：中继流量经过你的服务器，运营商/云厂商仍能看到加密流量的存在与大小；TURN 的合法合规责任（docs/03 R8）由自托管者承担，请自备 ToS 与关停机制。

---

## 8. 零存储审计

`tests/audit/zero-storage.sh` 有两种模式，都不需要 sudo。

### 8.1 本机进程 + strace（默认）

```bash
pnpm install                                   # 需要仓库依赖（tsx 用于驱动客户端）
tests/audit/zero-storage.sh                    # 默认 AUDIT_PORT=18787
AUDIT_PORT=18888 KEEP_TMP=1 tests/audit/zero-storage.sh
```

它做的事：

1. 用 `node infra/signaling/build.mjs` 构建生产 bundle；
2. 用 `strace -f -e trace=openat,openat2,write` 包住 `node build/server.cjs`，监听 18787；
3. 用 `tests/audit/signal-client.mts` 完成真实会话（create → join → approve → signal ×3 → close）；
4. 用 `tests/audit/analyze-trace.mjs` 断言：
   - 没有任何 `O_WRONLY/O_RDWR/O_CREAT/O_TRUNC/O_APPEND/O_TMPFILE` 的文件 open（排除 `/dev`、`/proc`、`/sys`）；
   - 没有 `write(2)` 落到“以写方式打开的文件 fd”（stdout/stderr/socket 不算）；
   - 没有任何数据库痕迹（`*.db` / sqlite / leveldb / redis / postgres）；
   - 服务端 stdout 只有一行启动日志，无 access log；
   - 客户端会话确实成功，且进程工作目录保持为空。

### 8.2 容器只读模式

```bash
tests/audit/zero-storage.sh --container
```

它会 `docker compose build/up` 一个独立项目（`crossfile-audit`），然后断言：

- `HostConfig.ReadonlyRootfs=true`、`Config.User` 非 root、`Mounts=0`、`Binds=null`、`CapDrop=ALL`、`no-new-privileges`；
- 健康检查 `healthy`（镜像内没有 curl，healthcheck 用 `node -e` 建 WebSocket 到 `/v1/ws`）；
- 真实会话 `CLIENT PASS`；
- `docker logs` 只有一行启动日志；
- `docker exec` 里写 `/app` 与 `/tmp` 都返回 `EROFS`（或 `EACCES`）；
- 最后 `docker compose down -v` 干净退出。

FAIL 都带 `[EVIDENCE]` 证据行并以退出码 1 结束。

> 注意：`strace` 只跟踪自己的子进程，普通用户即可，无需 `sudo`/`ptrace_scope` 调整。若你的发行版禁用了非特权 ptrace，本机模式会提示用 `--container`。

---

## 9. 验收记录（本机实跑）

> 以下输出为实际运行结果（本机 Docker 29 / Compose v5 / coturn 4.19.2-alpine / node:22-alpine）。
> 本机 8788 被 `pnpm dev` 的信令占用、8787 被一个无关服务占用，所以 compose 验收把宿主机映射端口改成 18787；容器内仍是 8787。

### 9.1 本机零存储审计

```console
$ tests/audit/zero-storage.sh
== Zero-storage audit (local process, strace) ==
[PASS] production bundle built (infra/signaling/build/server.cjs)
[EVIDENCE] server pid=42 (child of strace pid=35), port=18787
[EVIDENCE] server stdout: [crossfile-signaling] listening on ws://127.0.0.1:18787/v1/ws
[EVIDENCE] CLIENT OK connected ws://127.0.0.1:18787/v1/ws
[EVIDENCE] CLIENT OK created roomId=… code=275630
[EVIDENCE] CLIENT OK no turn credential (TURN_URIS unset on this server)
[EVIDENCE] CLIENT OK join_request guestId=…
[EVIDENCE] CLIENT OK join_ok host↔guest peerCaps=Object/chrome
[EVIDENCE] CLIENT OK signaled host→guest and guest→host (3 each)
[EVIDENCE] CLIENT OK room_closed reason=host_close
[EVIDENCE] trace: /tmp/crossfile-audit.JVFpIY/trace.txt (40 strace lines), server log: /tmp/crossfile-audit.JVFpIY/server.log
[PASS] signaling process opened no writable file (no O_WRONLY/O_RDWR/O_CREAT/O_TRUNC/O_APPEND/O_TMPFILE)
[PASS] no write(2) reached a file opened for writing (1 write(s) to stdout/stderr, 11 to sockets/pipes)
[PASS] no database file path was opened (no *.db / sqlite / leveldb / redis / postgres artefacts)
[PASS] server stdout has exactly 1 line, the startup line: [crossfile-signaling] listening on ws://127.0.0.1:18787/v1/ws
[PASS] no HTTP/access-log lines on stdout
[PASS] real signaling session completed through the audited process (7 steps, CLIENT PASS)
[PASS] process working directory stayed empty (/tmp/crossfile-audit.JVFpIY/cwd)
RESULT PASS
RESULT PASS (zero-storage audit, local)
```

### 9.2 容器模式（只读根文件系统 + 真实会话）

```console
$ AUDIT_PORT=18888 tests/audit/zero-storage.sh --container
== Zero-storage audit (container, read-only rootfs) ==
[EVIDENCE] compose project=crossfile-audit, published signaling port=18888, TURN_SECRET=(generated/supplied, not printed)
-- docker compose build signaling
[PASS] signaling image built
[PASS] container rootfs is read-only (HostConfig.ReadonlyRootfs=true)
[PASS] container runs as non-root user (1000:1000)
[PASS] container has no volumes or bind mounts (Mounts=0, Binds=null)
[PASS] all Linux capabilities dropped (CapDrop=["ALL"])
[PASS] no-new-privileges is set
[PASS] container healthcheck reports healthy (node ws probe on /v1/ws)
[EVIDENCE] CLIENT OK connected ws://127.0.0.1:18888/v1/ws
[EVIDENCE] CLIENT OK created roomId=… code=649534
[EVIDENCE] CLIENT OK no turn credential (TURN_URIS unset on this server)
[EVIDENCE] CLIENT OK join_request guestId=…
[EVIDENCE] CLIENT OK join_ok host↔guest peerCaps=Object/chrome
[EVIDENCE] CLIENT OK signaled host→guest and guest→host (3 each)
[EVIDENCE] CLIENT OK room_closed reason=host_close
[PASS] real signaling session completed against the container
[PASS] container stdout has exactly the startup line: [crossfile-signaling] listening on ws://0.0.0.0:8787/v1/ws
[PASS] writes inside the container fail as expected (app=EROFS tmp=EROFS)
[PASS] docker compose down -v completed (container and volumes removed)
RESULT PASS (zero-storage audit, container)
```

`docker compose up -d --build` 之后的状态与日志（同一套 compose）：

```console
$ docker compose -f infra/docker-compose.yml ps
NAME                    IMAGE                         SERVICE     STATUS                            PORTS
crossfile-coturn-1      coturn/coturn:4.19.2-alpine   coturn      Up ...                            0.0.0.0:3478->3478/udp, 0.0.0.0:3478->3478/tcp, 0.0.0.0:49160-49200->49160-49200/udp
crossfile-signaling-1   crossfile/signaling:local     signaling   Up ... (healthy)                   0.0.0.0:18787->8787/tcp

$ docker compose -f infra/docker-compose.yml logs signaling
crossfile-signaling-1  | [crossfile-signaling] listening on ws://0.0.0.0:8787/v1/ws
```

### 9.3 TURN 凭据与中继链路（signaling → coturn）

`docker compose up` 起好 coturn + signaling 后，真实会话客户端能拿到 TURN 凭据：

```console
$ node --import tsx tests/audit/signal-client.mts ws://127.0.0.1:18787/v1/ws
CLIENT OK connected ws://127.0.0.1:18787/v1/ws
CLIENT OK created roomId=64xhaj67dyogqc7arofatvijfu code=925275
CLIENT OK turn credential issued (username=1795506164:3S40hJTxgW4, ttl=3600, uris=turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp)
CLIENT OK join_request guestId=YPrk2sgxJZc
CLIENT OK join_ok host↔guest peerCaps=Object/chrome
CLIENT OK signaled host→guest and guest→host (3 each)
CLIENT OK room_closed reason=host_close
CLIENT PASS
```

signaling 真实下发的 `created.turn`（TTL 1h，HMAC 与 `packages/signaling/src/turn.ts` 完全一致）：

```text
created: {"roomId":"nculqode46rqoa3emzdkyx6irq","code":"618714","turn":{"uris":["turn:127.0.0.1:3478?transport=udp","turn:127.0.0.1:3478?transport=tcp"],"username":"1795505925:ax9Wa6ZGo1Y","credential":"3l1sXhMWbgimaQy8zqt5QWNoHiU=","ttl":3600}}
username: 1795505925:ax9Wa6ZGo1Y expires in 3600 s
hmac match: true | ttl: 3600
```

把这份凭据交给 coturn 自带的 TURN 客户端：

```text
INFO IPv4. Received relay addr: 127.0.0.1:49163
INFO start_mclient: tot_send_msgs=10, tot_recv_msgs=10
INFO Total lost packets 0 (0.000000%), total send dropped 2 (16.666667%)
```

即：signaling 签发的临时凭据被 coturn 接受、relay 端口落在配置区间、中继收发成功（AC2 的 TURN 链路前置条件）。

## 10. 常见故障

| 现象                                         | 原因 / 处理                                                                                                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURN_SECRET is required` / compose 直接退出 | 没复制 `infra/.env`。`cp infra/.env.example infra/.env` 并填 `TURN_SECRET`。                                                                                                                                            |
| signaling 健康检查一直 `unhealthy`           | 端口被占（`SIGNAL_PORT` 与宿主机其他进程冲突，例如 `pnpm dev:signal` 已占用 8788），或容器启动失败；`docker compose logs signaling` 看启动那一行。健康检查固定探容器内 `127.0.0.1:8787`，不要在 `.env` 里改容器内端口。 |
| 页面能连信令但传输极慢/总是失败              | TURN 不可达。检查 3478/udp+tcp、49160–49200/udp 的安全组；`TURN_URIS` 的域名解析到公网 IP；浏览器 webrtc-internals 看 candidate 是否只有 host/srflx。                                                                   |
| 中继 candidate 是 `relay` 但连不上           | 典型是 NAT：本机联调用 `docker-compose.hostnet.yml`；公网主机确认 `TURN_URIS` 用的是公网域名而非内网 IP，且 relay 端口段全部放行。                                                                                      |
| webrtc-internals 里 ICE 一直 `checking`      | 凭据过期（TTL 1h，`TURN_TTL_SEC`）或 secret 与 signaling 不一致；核对 `.env` 的 `TURN_SECRET` 两边同源。                                                                                                                |
| `docker compose build` 卡在 `pnpm install`   | 主机访问 npm registry 慢/被墙。给 Docker daemon 配代理（`/etc/docker/daemon.json` 的 `proxies`）或 `docker build --build-arg` 注入；镜像构建需要能访问 npm 与基础镜像仓库。                                             |
| `permission denied` 写文件/挂载              | 设计如此：只读根文件系统 + 非 root + 无 volume。别加 `volumes`，需要持久化的东西不应该存在于这套部署里。                                                                                                                |
| 审计本机模式报 `strace is not installed`     | `apt install strace`；或改用 `--container`。                                                                                                                                                                            |
| 审计 `--container` 报端口占用                | `AUDIT_PORT=18888 tests/audit/zero-storage.sh --container`。                                                                                                                                                            |
| 反代 502 / WebSocket 连不上                  | 反代没有转发 Upgrade 头，或 `/v1/ws` 指到了错误端口；Caddy 的 `reverse_proxy` 默认支持 Upgrade，Nginx 需要手写 `proxy_set_header Upgrade $http_upgrade` 等。                                                            |
| HTTPS 证书问题（TURN over TLS 未启用）       | 本方案 TURN 用明文 3478；若要求 TURN over TLS（5349），需要给 coturn 配证书并开放 5349/tcp+udp，自行在 compose 里加参数，signaling 下发的 `TURN_URIS` 改成 `turns:`。                                                   |

---

## 生产单源部署（一个容器同时服务网页与信令）

镜像构建阶段会跑 `vite build`，并把 `apps/web/dist` 放进运行时镜像的 `/app/public`，容器里 `STATIC_DIR=/app/public`。也就是说：

- 一个端口（容器 8787，宿主机默认映射 8788）同时提供页面、静态资源与 `/v1/ws`；
- 页面响应自带安全头：`Referrer-Policy: no-referrer`（fragment 里的密钥不会被 referer 带走）、严格 CSP、`Permissions-Policy`；
- SPA 路由（`/r/:id`、`/j/:code`、`/code`、`/privacy`）回退到 `index.html`；`/assets/*` 走 `immutable` 缓存；
- 仍然**没有**访问日志、没有 cookie、没有写盘（`bash tests/audit/zero-storage.sh --container` 覆盖这一点）。

本地已验证两条路径：
1. 直接用源码：`PORT=8791 STATIC_DIR=$PWD/apps/web/dist pnpm --filter @crossfile/signaling start`，Playwright 两上下文对 `http://127.0.0.1:8791` 传输 10 MB（哈希一致）；
2. **生产镜像**：`docker build -f infra/signaling/Dockerfile -t crossfile/signaling:local .` → `docker compose -f infra/docker-compose.yml up -d signaling`，`http://127.0.0.1:18788/` 返回页面与安全头、`/r/<id>` SPA 回退 200、Playwright 传输通过；容器只读根文件系统下 `tests/audit/zero-storage.sh --container` 仍 PASS。

反代只负责 TLS 终结与可选的限流（`infra/deploy/Caddyfile.example`），转发到容器 8788 即可。

---

## GitHub Actions 自动部署（GHCR + SSH）

`.github/workflows/deploy.yml`：推到 `main`（或手动 `workflow_dispatch`）后自动完成
「门禁 → 构建镜像 → 推 GHCR → SSH 滚动更新 → 健康检查 → 可选公网 smoke」。

### 它做了什么

1. **build job**：`pnpm lint / typecheck / test` 快速门禁 → `docker buildx` 用
   `infra/signaling/Dockerfile` 构建（含前端与 `STATIC_DIR`）→ 推到 `ghcr.io/<owner>/<repo>/signaling`
   两个 tag：`:sha`（12 位提交号，用于回滚）和 `:latest`；GHA 层缓存。
2. **deploy job**（`environment: production`，可加人工审批）：
   - `scp` 同步 `infra/docker-compose.yml`、`infra/docker-compose.hostnet.yml`、`infra/deploy/Caddyfile.example`
     到服务器 `DEPLOY_PATH`（**不会覆盖服务器的 `infra/.env`**）；
   - SSH 执行：检查 `.env` 存在 → 可选 `docker login ghcr.io` → `SIGNALING_IMAGE=<新镜像> docker compose pull signaling`
     → `up -d --remove-orphans` → 轮询容器 healthcheck（最多 60 s，失败打印最后 40 行日志并让 job 失败）
     → 若配置了 `PUBLIC_BASE_URL` 再 `curl -f` 验证公网入口。

### 需要在 GitHub 配置的 Secrets

| Secret | 必填 | 说明 |
|---|---|---|
| `DEPLOY_HOST` | ✅ | 服务器域名或 IP |
| `DEPLOY_USER` | ✅ | SSH 用户，需在 `docker` 组（能执行 docker compose） |
| `DEPLOY_SSH_KEY` | ✅ | 该用户的私钥（建议 ed25519，只用于部署） |
| `DEPLOY_PATH` | ✅ | 服务器上的仓库路径，例如 `/srv/crossfile` |
| `GHCR_PULL_TOKEN` | 可选 | 若 GHCR package 为私有：PAT（`read:packages`）。把 package 设为 public 后可省略 |
| `DEPLOY_PORT` | 可选 | SSH 端口，默认 22 |
| `PUBLIC_BASE_URL` | 可选 | 例如 `https://room.example.com`，设置后会做公网 smoke test |

### 服务器一次性准备

```bash
# 1) 部署用户 + docker 组（示例）
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy

# 2) clone 仓库并准备 .env（只需做一次；之后 CI 只更新容器）
sudo mkdir -p /srv/crossfile && sudo chown deploy:deploy /srv/crossfile
sudo -u deploy git clone https://github.com/<owner>/<repo>.git /srv/crossfile
sudo -u deploy cp /srv/crossfile/infra/.env.example /srv/crossfile/infra/.env
sudo -u deploy "$EDITOR" /srv/crossfile/infra/.env   # TURN_SECRET / TURN_URIS / TURN_EXTERNAL_IP / PUBLIC_HOST

# 3) 反代指向 127.0.0.1:8788（Caddy/nginx 均可，见本文件上一节）
```

把部署用户的公钥加到 GitHub Deploy Key 只在需要 `git pull` 时才需要；本工作流用镜像部署，
**不需要服务器能访问 GitHub 仓库**。

### 首次与回滚

首次：Actions → `deploy` → `Run workflow`，或直接 push 一个提交到 `main`。

回滚到上一版（在服务器上）：

```bash
cd /srv/crossfile
SIGNALING_IMAGE=ghcr.io/<owner>/<repo>/signaling:<旧 sha> \
  docker compose -f infra/docker-compose.yml up -d --remove-orphans
```

### 注意

- 工作流只重启 `signaling`，**不会**更新 coturn 镜像；coturn 升级请手动 `docker compose pull coturn`。
- 镜像默认 `linux/amd64`。ARM 服务器把 workflow 里的 `platforms` 改为 `linux/arm64`（或 `linux/amd64,linux/arm64`）。
- GHCR package 默认私有；要公开：GitHub → Packages → 该 package → Package settings → Change visibility。
- 生产建议：给 `production` environment 加 Required reviewers；把第三方 action（appleboy/*）pin 到 SHA。
- 部署会中断进行中的传输（房间在内存里），尽量避开高峰；失败时 job 会 fail 并保留旧容器继续服务。
