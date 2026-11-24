# 官方实例部署清单（M4）

> 目标：把 `infra/` 里的 signaling + coturn 放到一台有公网 IPv4 的服务器上，用你已有的域名提供
> `https://<domain>` 页面与 `/v1/ws`，并让 TURN 中继对公网可用。所有命令都在仓库根目录执行。

## 1. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 服务器 | Linux + Docker（含 compose 插件）、≥2 vCPU / 2 GB RAM | signaling 常驻内存；coturn 按中继流量吃带宽 |
| 域名 | `<domain>` 的 A 记录指向服务器公网 IPv4 | 页面、`wss://` 与 TURN 凭据里的地址都靠它 |
| 公网 IPv4 | 记作 `<public-ip>` | **`TURN_EXTERNAL_IP` 必须填这个值**；填 127/172 会导致中继不可用 |
| 端口 | 80/443 tcp（反代）、3478 tcp+udp、49160–49200 udp | 云厂商安全组与主机防火墙都要放行 |
| TLS | 由反代终结（Caddy/nginx 均可） | 容器内部只跑明文 HTTP/WS，绝不直接暴露 8788 |
| 带宽 | 中继流量按「上行 + 下行」计费 | 见 §6 成本估算；官方实例建议对中继限速 |

## 2. 配置

```bash
cp infra/.env.example infra/.env
$EDITOR infra/.env
```

关键变量：

```ini
TURN_SECRET=<openssl rand -hex 32>
TURN_URIS=turn:<domain>:3478?transport=udp,turn:<domain>:3478?transport=tcp
TURN_EXTERNAL_IP=<public-ip>
PUBLIC_HOST=<domain>
SIGNAL_PORT=8788
COTURN_MIN_PORT=49160
COTURN_MAX_PORT=49200
```

说明：
- `TURN_URIS` 用域名而不是 IP：Safari/iOS 对 `turn:` 的凭据与 URI 更严格，域名 + 有效 TLS 反代是稳妥组合；
- `TURN_SECRET` 只给 signaling 与 coturn 用，**不要**在前端出现；
- 官方实例建议把 `MAX_GUESTS` 设为 2（docs/01 D13），自托管默认 4。

## 3. 起服务

```bash
docker build -f infra/signaling/Dockerfile -t crossfile/signaling:local .
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps      # signaling (healthy) + coturn Up
```

镜像内 `STATIC_DIR=/app/public`，所以 **一个端口同时提供网页与 `/v1/ws`**；反代只做 TLS + 转发：

```caddyfile
<domain> {
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }
    reverse_proxy 127.0.0.1:8788
}
```

`infra/deploy/Caddyfile.example` 是同样内容的模板（含开发期 `room.net.time-pack.com → 5173` 注释块）。

## 4. 验收（逐条跑，全部通过才算上线）

```bash
# 页面 + 安全头（Referrer-Policy 必须是 no-referrer；CSP 必须存在）
curl -sI https://<domain>/ | grep -iE "referrer-policy|content-security-policy|permissions-policy"

# SPA 路由回退
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/r/abcdefghijklmnopqrstuvwxyz   # 200

# WebSocket 升级（经反代必须是 101）
curl -s --http1.1 -i -N -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://<domain>/v1/ws | head -1

# 真实传输：两台设备打开 https://<domain>，500 MB，双方 SHA-256 一致，路径标签正确
# （公开实例上跑 AC1/AC3 的手工版即可）

# 零存储审计（只读容器）
SKIP_BUILD=1 TURN_SECRET=<secret> bash tests/audit/zero-storage.sh --container
```

## 5. 运维边界（与设计一致）

- **没有数据库**：进程重启 = 所有房间消失（docs/01 D1/D7），客户端会收到「连接已失效，请重新创建房间」——这是预期行为，不要临时加重试「恢复房间」。
- **没有访问日志**：只允许 `error` 级、脱敏日志；反代层也不要开 per-request 访问日志（否则 IP 与房间 ID 会落到磁盘）。
- **单实例**：不做多副本/集群（房间在内存）。要扩容只能按域名分片，不是本轮范围。
- **升级**：`docker compose pull/build` → `up -d --force-recreate signaling`；升级会切断所有进行中的传输，请在低峰期做。
- **监控**：只有 healthcheck 与进程/带宽指标；不要为了排障打开请求日志。
- **限流**：`packages/signaling` 已按 IP 做内存限流（默认 60 s / 120 条）；官方实例另建议在反代层限并发连接数与单 IP 带宽。

## 6. 中继成本与容量（事实表附录 A §4 口径）

- Cloudflare Realtime TURN：约 `$0.05/GB`（出站）；Metered：150 GB/$99（超出 $0.40/GB），且**入站+出站都计费**。
- 一个 500 MB 文件经中继 = 约 1 GB 流量（收发各计入时更多），按 Metered 价约 $0.4；按 CF 价约 $0.05。
- 因此官方实例的策略是：**优先直连**（D2 阶梯），中继只做兜底 + 限速 + 每会话总量上限（D13/R6）。

## 7. 合规与对外文案

- 隐私说明页 `/privacy` 与 README/自托管文档措辞一致（docs/01 §5），改字需过审；
- TURN 中继意味着会转发他人的密文流量：官方实例需要 ToS、滥用举报入口与关停机制（R8）；
- 不记录内容与身份，但保留「可被举报、可被关停」的运营手段。

## 8. 已知限制

- 只有 Linux 容器验证过（本仓库在 Ubuntu 24.04 + Docker 29 上实测）；macOS/Windows 自托管未验；
- 官方实例的外网真实 10 Mbps 中继 500 MB <10 分钟尚未实网验证（本地 coturn 已通过）；
- iOS/Safari 的「保存」动作需要用户手势，自动化只能验证到「接收 + 哈希一致」。
