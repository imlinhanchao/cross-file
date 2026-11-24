# CrossFile 协议设计 v0.1

> 配套：`01-design.md`（决策）｜`03-roadmap.md`（工程）
> 目标读者：实现者。所有字段、状态机、错误码以此为准；未写到的都算「未定义」，不得自行发明。

---

## 1. 术语与常量

| 名称 | 说明 |
|---|---|
| `H` | 房主 / 发送方（host） |
| `G` | 接收方（guest），可多个 |
| `S` | 信令服务器（signaling） |
| `T` | TURN 中继 |
| `roomId` | 16 字节随机数，base32 编码 26 字符，可公开 |
| `roomKey` | 32 字节随机数，只在 fragment / SAS 认证后的通道出现 |
| `peerId` | 连接内随机 8 字节，由 S 分配 |
| `chunk` | 明文分片，默认 64 KiB，可升级至 256 KiB |

常量：`PROTOCOL_VERSION = 1`；`CHUNK_MIN = 64 KiB`；`CHUNK_MAX = 256 KiB`（受 `sctp.maxMessageSize` 限制）；`HWM = 8 MiB`（发送高水位）；`LWM = 2 MiB`；`RECONNECT_WINDOW = 60 s`；`ROOM_TTL = 30 min`；`HEARTBEAT = 20 s`；`TURN_TTL = 1 h`。

---

## 2. 威胁模型与信任边界

### 2.1 参与方与能力假设

- `S` 和 `T` 被当作**诚实但好奇，甚至可能是恶意**：它们可以看到 IP、房间存在时间、字节量，可能篡改信令、注入假接收方、主动掉线。
- 网络上的被动攻击者只能看到加密流量。
- 浏览器/App 终端本身是可信的（不防终端被攻破）。
- 传输层：到 `S` 用 `wss://`，到 `T` 用 `turns://`；数据通道本身是 DTLS-SCTP 端到端加密。

### 2.2 承诺与不可避免的暴露

| 资产 | 对 S/T 保证 | 机制 |
|---|---|---|
| 文件内容 | 不可读 | 应用层 AES-256-GCM；TURN 只转发 DTLS 密文 |
| 文件名、大小、清单 | 不可见 | 清单走数据通道，S 不参与 |
| roomKey | 不可见 | 只在 URL fragment / 数据通道 |
| 元数据：IP、时间、字节量 | **可见** | NAT 穿透的物理成本，写入隐私说明 |
| 连接内容完整性 | 可检测篡改 | SAS（6 位码路径）/ fragment 密钥（QR 路径） |

### 2.3 针对恶意 S 的攻击面

1. **注入假接收方**：QR 路径要求加入时附带 `proof = HMAC-SHA256(roomKey, "join:" || roomId || guestNonce)`；S 不知道 roomKey，无法伪造。此外房主仍需人工批准。
2. **MITM 信令（替换 SDP 指纹）**：QR 路径密钥在带外，AES-GCM 解密失败即中止；6 位码路径靠 4 emoji SAS 绑定双方 DTLS 指纹。
3. **重放/冒用**：房间短命（≤30 分钟）、roomKey 每次会话新生成、`roomId` 不可预测。
4. **DoS / 掉线**：无法防；UI 必须把「连接失败」讲清楚，而不是假装成功。

---

## 3. 房间与信令协议

### 3.1 传输

WebSocket（`wss://<host>/v1/ws`），消息为 JSON 文本帧；大于 64 KiB 的消息拒绝。所有消息带 `v`、`type`、`id`（客户端消息序号，用于回执）。

### 3.2 消息表

**客户端 → S**

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `v, clientCaps` | 建连后第一条；上报自身能力（§5） |
| `create` | `roomId, hostCaps` | 创建房间；H 发送 `hostCaps` |
| `join` | `roomId, guestCaps, guestNonce, proof?` | 申请加入；QR 路径必须带 `proof` |
| `approve` | `guestId` | H 批准某接收方 |
| `deny` | `guestId, reason` | H 拒绝 |
| `remove` | `guestId` | H 移除已加入的接收方 |
| `signal` | `to, payload` | 透传 WebRTC 信令：`{k:"offer"|"answer"|"candidate", sdp?, candidate?}` |
| `heartbeat` | `roomId` | 每 20 s 一次，续期房间 |
| `close` | `roomId` | H 主动结束房间 |

**S → 客户端**

| type | 字段 | 说明 |
|---|---|---|
| `created` | `roomId, turn?` | 房间创建成功；可选附 TURN 凭据 |
| `join_request` | `guestId, guestCaps, guestNonce, proof?` | 转发给 H 等待批准 |
| `join_ok` | `guestId, hostCaps, turn` | 批准后发给 G，附 H 能力与 TURN 凭据 |
| `join_rejected` | `reason` | 拒绝/超时/房间不存在 |
| `signal` | `from, payload` | 透传 |
| `peer_left` | `guestId` | 用于 UI 与续传判定 |
| `room_closed` | `reason` | `host_close` / `ttl` / `error` |
| `turn` | `uris, username, credential, ttl` | 按需下发 |
| `error` | `code, msg` | 见 §3.6 |

### 3.3 房间状态机（S 侧，全部在内存）

```
created ──join_request──▶ awaiting_approval ──approve──▶ joined ──peer_left──▶ created
   │                           │                            │
   │                           └──deny/timeout──▶ created   └──close──▶ closed（立即从内存删除）
   └──ttl(30min 无活动)──▶ closed
```

- 房间对象只存：`roomId, hostPeerId, hostCaps, guests[], createdAt, lastActivity`。**不存 IP、不存 UA 原文、不写磁盘。**
- `hostCaps/guestCaps` 仅在内存中转发给对端，S 不记录。

### 3.4 加入时序（QR 路径，推荐）

```
G 打开 /r/<roomId>#<roomKey>
G → S   join {roomId, guestCaps, guestNonce, proof}
S → H   join_request {...}
H → S   approve {guestId}
S → G   join_ok {hostCaps, turn}
S → H   join_ok（对端能力）
H ↔ G   经 S 透传 offer/answer/candidate（H 发起 offer）
H ↔ G   PC 连接，开两个数据通道：ctrl（JSON）、data（二进制）
G → H   ctrl: hello {guestCaps, bitmapSupport:true}
H 校验 proof，加入审批名单
```

### 3.5 加入时序（6 位码路径）

```
G 输入 6 位数字码 → S 用短码映射到 roomId（短码 10 分钟有效、单次使用）
G → S   join {roomId, guestCaps, guestNonce}   // 无 proof
（同 3.4，但批准后 H 不立即发文件）
H ↔ G   数据通道建立 → 双方各自计算 SAS（§4.5）→ 屏幕显示 4 emoji
H/G     人工比对，两侧都点「一致」→ H 通过 ctrl 发送 roomKey（32B）→ G 用 HMAC 验证
任一侧点「不一致」或 60 s 未确认 → 中止，房间不受影响
```

### 3.6 错误码

| code | 含义 |
|---|---|
| `ROOM_NOT_FOUND` / `ROOM_CLOSED` | 房间不存在/已结束 |
| `ROOM_FULL` | 接收方数量已达上限（官方实例 2，自托管默认 4） |
| `PROOF_INVALID` | QR 路径 proof 校验失败（可能被 S 注入） |
| `SAS_MISMATCH` | 6 位码路径指纹不一致 |
| `TOO_LARGE` | 超过该接收端硬上限 |
| `CAPABILITY_RISK_DECLINED` | 接收方拒绝超软上限文件 |
| `HASH_MISMATCH` | 全文件 SHA-256 不一致 |
| `TIMEOUT` | 握手或续传超时 |
| `PEER_GONE` | 对端断开且超过续传窗口 |
| `RATE_LIMITED` | 超过信令/中继频率限制 |

---

## 4. 密钥、加密与完整性

### 4.1 密钥派生

```
roomKey   = 32B random (crypto.getRandomValues)           // 只在 fragment
joinProof = HMAC-SHA256(roomKey, "join:" || roomId || guestNonce)
sessionKey= HKDF-SHA256(roomKey, salt=roomId, info="crossfile/v1/session", 32B)
fileKey   = HKDF-SHA256(sessionKey, info="file:" || fileId, 32B)
fileSalt  = 4B random（每文件，随清单下发）
```

### 4.2 分片加密（AES-256-GCM）

- 每片明文 `P`（≤ CHUNK），密文 = `AES-GCM(fileKey, nonce, P, aad)`，tag 16B 附在密文尾。
- `nonce = fileSalt(4B) || chunkSeq(8B, big-endian)` → 12B，每文件每片唯一。
- `aad = fileId(2B) || chunkSeq(4B) || len(4B)` → 防重排、防截断、防错位。
- 每片独立认证：缺片、乱序、篡改单独立即可发现。

### 4.3 清单（manifest）

```
{
  v: 1,
  files: [
    { id: 1, name: "demo.mp4", size: 367001600, mime: "video/mp4",
      chunk: 65536, chunkCount: 5600, salt: <base64 4B>, fileKeyHint: "file:1" }
  ],
  totalSize: ...,
  chunkNegotiation: { min: 65536, max: 262144 }
}
```
实际分片大小取双方 `sctp.maxMessageSize` 与 `chunk` 的较小者，双方在 `hello` 中协商后固定，中途不变（续传时沿用原值；若对端重连后 maxMessageSize 变化，仍用旧值，只允许原值 ≤ 新上限）。

### 4.4 全文件校验

- 发送方在发送过程中用增量 SHA-256（`@noble/hashes`，避免把 500MB 攒进内存）计算明文摘要；结束时 `ctrl: done {fileId, sha256}`。
- 接收方边收边算，`done` 到达后比对；不一致 → `error HASH_MISMATCH`，该文件判定失败（允许重试一次整文件）。

### 4.5 SAS（6 位码路径）

```
fpLocal   = SHA-256(DTLS 本地证书指纹)      // 来自 SDP a=fingerprint
fpRemote  = SHA-256(SDP 中对方的 a=fingerprint)
pairs     = sort([fpLocal, fpRemote])
sasBits   = HKDF-SHA256(concat(pairs), info="crossfile/v1/sas", 4B)
emoji[i]  = EMOJI_64[ (sasBits[i] >> 2) & 0x3F ]   // 4 个 emoji，24 bit
```
双方必须显示相同 4 个 emoji；不一致意味着 S 可能做了中间人。

### 4.6 密钥生命周期

- 房间创建时生成；房主点「结束房间」/房间过期/页面关闭 → 丢弃引用并尽力清零（JS 无法保证物理清零，原生壳层额外覆写）。
- 不做密钥持久化，不进 localStorage/IndexedDB。

---

## 5. 能力包与动态限制（D16）

`guestCaps` 结构（`hello` / `join` 上报，S 仅转发不记录）：

```
{
  platform: "win"|"mac"|"linux"|"ios"|"android"|"harmony",
  uaFamily: "chrome"|"edge"|"safari"|"firefox"|"arkweb"|"unknown",
  nativeShell: false,
  secureContext: true,
  fsAccess: false,          // showSaveFilePicker / createWritable
  sw: true,
  swDownload: false,        // Service Worker 流式下载可用（Safari 15.4+，需自研实现）
  saveStrategies: ["blob"], // 优先级：native | fs | sw | blob
  deviceMemoryGB: 4,        // 可得则填
  storageQuotaMB: 10240,
  screen: "phone"|"tablet"|"desktop"
}
```

发送方规则（`packages/core/src/capability/limits.ts`，可配置）：

1. `nativeShell === true` → 500/500
2. `fsAccess === true && uaFamily in {chrome,edge}` → 500/500
3. `uaFamily in {safari,firefox}` → 250/500
4. `platform === "ios"` → 100/500（强提示）
5. `platform === "android"` → 150/500
6. 其余/未知 → 150/500

流程：选文件后先按接收方算上限 → 超软上限弹提示并记录选择 → 超硬上限禁止勾选该接收方。接收方在 `accept` 前收到 manifest，按自身能力再校验一次，超软上限必须二次确认，超硬上限直接拒绝（`error TOO_LARGE`）。

---

## 6. 传输协议

### 6.1 数据通道

- `ctrl`：`ordered=true`、`reliable`，JSON 控制消息（manifest / accept / bitmap / done / error）。
- `data`：`ordered=true`、`reliable`，二进制分片帧（v1 不做 unordered 并行，保证顺序与简化续传）。
- 通道开启顺序：先 `ctrl` 再 `data`；`data` 上禁止发控制消息。

### 6.2 帧格式（data 通道，小端）

```
offset  size  field
0       1     type        // 1 = CHUNK
1       2     fileId
3       4     chunkSeq
7       4     len         // 密文长度（含 16B tag）
11      1     flags       // bit0 = LAST_CHUNK
12      N     ciphertext  // N == len, 硬上限 262144
```
单帧总长 ≤ 262 160 B，必须 ≤ 双方 `sctp.maxMessageSize`；默认 64 KiB 明文 + 28 B 头 + 16 B tag。

### 6.3 流控

发送循环：`while (dc.bufferedAmount < HWM) send(frame)`；`bufferedAmountLowThreshold = LWM`，在 `onbufferedamountlow` 时继续。收到 `ctrl: pause` 立即停；收到 `ctrl: resume` 继续。

### 6.4 发送流程（单文件）

1. H → `ctrl: manifest`（所有待发文件）
2. G → `ctrl: accept {fileIds}`（或 `error` 拒绝某些文件）
3. H 按 `fileIds` 顺序逐文件发 CHUNK；每 100 片（≈6.5MB）发一次 `ctrl: progress {fileId, seq}`（G 也可不发，用于 UI）
4. H → `ctrl: done {fileId, sha256, chunkCount}`
5. G 校验 → `ctrl: ack {fileId, ok}` 或 `error HASH_MISMATCH`
6. 下一个文件

### 6.5 续传状态机

```
        ┌────────── channel lost ──────────┐
        ▼                                  │
 [transferring] ──lost──▶ [paused] ──reconnect ≤60s──▶ [resuming] ──received bitmap──▶ [transferring]
        │                        │
        │                        └──>60s──▶ [failed]（对端可重新加入，新会话）
        └──done/err──▶ [completed/failed]
```

- 任一侧检测到 `data`/`ctrl` 通道关闭 → 本地置 `paused`，保留：已发/已收分片状态、文件 key、salt、分片大小。
- H 在 60 s 内重新走信令（同房间、同 guestId），重建 PeerConnection；G 收到后发 `ctrl: bitmap`。
- **bitmap**：按分片序号，1 = 已收到；长度 = `ceil(chunkCount/8)` 字节，base64 传输。500MB/64KiB = 8000 片 → 1000 B → base64 约 1.4 KB。
- H 只重发缺失分片；`chunkSeq` 不变，nonce 不变（因此不需要重加密）。
- 续传期间不重发 manifest（双方内存里都有）；若 G 页面刷新（内存丢失）→ 无法续传，只能重新加入新房间。

### 6.6 ICE 路径选择与时序（D2）

1. `new RTCPeerConnection({iceServers: [stun(官方), turn(ephemeral)]})`
2. H 建 `data` channel 后 createOffer；G setRemote → createAnswer；Trickle ICE 透传。
3. ICE 自动按 candidate pair 优先级选路：host↔host（① 同网）> srflx↔srflx（④ 跨网打洞）> relay（⑤ 中继）。
4. 连接后 `pc.getStats()` 读取选中候选对 → 映射成 UI 标签「局域网直连 / 直连 / 中继」，并显示实时速率。
5. 不允许中途切路（v1）；路径变差只影响速度，不触发切换。

### 6.7 TURN 凭据

- S 用 coturn 的 `static-auth-secret` 模式签发：`username = "<expiryEpoch>:<peerId>"`，`credential = base64(HMAC-SHA1(secret, username))`，TTL 1 h。
- 仅在需要时下发（`created`/`join_ok`）；每个 peer 每次连接一份；官方实例按 IP 限频（内存计数，不落盘）。

---

## 6.8 接收端保存层（sink）

接收方在 `hello` 中按优先级上报 `saveStrategies`；发送方只负责传字节，保存策略由接收方决定，发送方不感知。

| 策略 | 条件 | 行为 |
|---|---|---|
| `native` | 原生壳 | 收到分片后按偏移直接写盘，支持续传随机写 |
| `fs` | `fsAccess === true`（Chromium 桌面） | `showSaveFilePicker` 取句柄，按分片流式写入 |
| `sw` | `swDownload === true`（Safari 15.4+，**自研**） | 页面经 `MessageChannel` 把解密分片推给同源 Service Worker；SW 用 `respondWith(new Response(stream, {headers:{"Content-Disposition":"attachment; filename=…"}}))` 交给浏览器下载管理器增量写盘 |
| `blob` | 兜底 | 分片攒进内存 `Blob`，完成时 `createObjectURL` + `<a download>`；超过 §5 软上限必须二次确认 |

约定：`sw` 要求页面与 Service Worker 同源（应用天然满足），下载 URL 带一次性随机 token、SW 校验后才返回流；**不使用第三方 StreamSaver.js**（其在 Safari 会退回 Blob 兜底）。`sw` 失败自动降级 `blob`。

---

## 7. 服务端「零存储」实现约束

1. 房间、peer、速率计数器全部在进程内存（Map + 定时 sweep），**无数据库、无 Redis、无写文件**。
2. 日志：只允许 `error` 级、且不含 IP/UA/roomId 原文；关闭访问日志；容器 stdout 仅启动信息。禁止把 `req` 对象整体打进日志。
3. 不设 cookie、不设指纹、不引第三方统计 SDK。
4. 优雅关闭时清空内存；崩溃重启丢失所有房间（可接受，符合「用完即走」）。
5. coturn：日志级别调至最低、日志写 tmpfs（内存），不落持久盘；`no-cli`；禁用 `no-loopback-peers` 之外的多余插件。
6. 自托管用 docker-compose：`signaling` + `coturn` 两个服务，一个 `.env` 配置域名/TURN secret。

---

## 8. 边界与失败处理

| 场景 | 行为 |
|---|---|
| 接收方刷新页面 | 内存态丢失 → 当作离开，房主 UI 移除；需重新加入 |
| 发送方刷新/锁屏 | 房间立即失效（heartbeat 停止且页面卸载发 `close`）；原生壳靠前台服务保活 |
| 传输中接收方切后台 | 浏览器可能冻结数据通道 → 断流 → 60 s 续传窗口；超时失败并提示「请保持前台/装 App」 |
| 文件被接收方拒绝 | `error CAPABILITY_RISK_DECLINED`，房主 UI 显示原因 |
| 两个接收方同时加入 | 顺序：房主批准后进入队列，一次只服务一个 |
| 接收方中途被移除 | 立刻断开，房主 UI 标注「已移除」，队列跳过 |
| 中等质量网络丢包 | SCTP 重传兜底；进度可能停顿，UI 显示「重传中」而非误报完成 |
| 服务器重启 | 所有房间消失，客户端收到断线 → 提示「连接已失效，请重新创建房间」 |

---

## 9. 待实测校准的协议参数

| 参数 | 初值 | 校准方式 |
|---|---|---|
| 分片大小 | 64 KiB（可升 256 KiB） | 局域网 500MB 实测吞吐对比 |
| HWM/LWM | 8 / 2 MiB | 同上，找吞吐拐点 |
| 续传窗口 | 60 s | 移动端锁屏/切后台实测 |
| 能力阈值 | §5 表 | 各平台 500MB 实测成功/失败边界 |
| 心跳间隔 | 20 s | 移动网络省电与房间存活平衡 |

---

## 10. 实现注记（v1 落地时补的定义，与上文同为事实源）

上文未定义的字段/行为在实现时按下列约定补全；代码位置一并给出，改动需同步本表。

### 10.1 信令消息

| 位置 | 补全 | 代码 |
|---|---|---|
| `created` | 增加 `code`（6 位数字字符串，加入用短码，10 min、单次） | `packages/signaling/src/rooms.ts` / `shortcode.ts` |
| `join.roomId` | 允许直接传 6 位数字码；服务端在 schema 校验前映射为 roomId | `packages/signaling/src/server.ts` |
| `join_ok` | `peerCaps` 表示**对端**能力（host 收 guestCaps，guest 收 hostCaps）；`turn` 在未配置 coturn 时可缺省 | `packages/signaling/src/server.ts` / `packages/core/src/protocol.ts` |
| `signal.to` | guest→host 可用哨兵 `"host"`（guest 不知道 hostPeerId）；host→guest 用 `guestId` | 同上 |
| host 重连 | 同 roomId 且原 host socket 已断时，`create` 视为重连：沿用房间/guest/短码 | `packages/signaling/src/server.ts` |
| 房间清理 | host socket 断开不立即销毁（保留 60 s 续传窗口），由 ≤30 min 空闲 TTL 统一清理 | 同上 |

### 10.2 控制通道（ctrl，JSON 文本帧）

统一形如 `{ "v": 1, "type": "<name>", ... }`：

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `guestCaps` | 通道建立后 guest 先发 |
| `manifest` | `files[{id,name,size,mime,chunk,chunkCount,salt}], totalSize, chunkNegotiation` | `salt` 为 4 B base64；只含该接收方被勾选的文件 |
| `accept` | `fileIds[]` | 接收方确认接收的文件 |
| `bitmap` | `fileId, bits` | base64，1 bit/片，1=已收到；用于续传补片 |
| `progress` | `fileId, seq` | 发送侧每 100 片一次（仅 UI） |
| `done` | `fileId, sha256, chunkCount` | 发送完毕，附全文件摘要 |
| `ack` | `fileId, ok, error?` | 接收方校验结果 |
| `error` | `code, msg, fileId?` | 见 §3.6 错误码 |
| `pause` / `resume` | — | 预留（v1 UI 未暴露） |
| `sas-confirm` | — | 6 位码路径：接收方确认 4 emoji 一致 |
| `room-key` | `key, roomId` | 双方都确认后 host 经 ctrl 下发 roomKey（base64url，32 B）与 roomId |
| `key-ok` | — | 接收方收到密钥并派生 sessionKey 后回执 |

### 10.3 分片与续传

- 实际分片大小 = `min(chunk, sctp.maxMessageSize - 12 - 16)`（`effectiveChunkSize`），manifest 必须宣告该值；
- 发送方在发 manifest 前对每个文件**预先计算**全文件 SHA-256（续传时复用），发送循环本身不维护哈希；
- 续传：接收方发 `bitmap`，发送方只重发缺失片，`fileId`/`seq`/nonce 不变（密文可逐字节相同），随后重新发 `done`；
- 发送方在 60 s 窗口内以同 roomId 重新建连（host 重连），接收方保留 receiver 状态。

### 10.4 保存层实现状态

| 策略 | 状态 |
|---|---|
| `blob` | ✅ 已实现（默认兜底） |
| `native` | ✅ 已实现：Tauri 桌面/手机壳 `save_open/save_write(offset)/save_close/save_abort`，按偏移随机写 |
| `fs` | ✅ 已实现：`showSaveFilePicker` + 按偏移写（Chromium 桌面） |
| `sw` | ⏳ 未实现（M2 待做，见 ADR 0002；Safari/iOS 大文件保存依赖它） |

### 10.5 与上文的其他差异

- §5 的 `storageQuotaMB` 由接收/发送端在 `hello/create/join` 前用 `navigator.storage.estimate()` 探测后填入；
  `judgeFile` 在平台阈值之外还会用配额判断（超配额的 80% 警告、超配额拒绝），避免承诺存不下的文件；
- §2.3「H 校验 proof」已落地：proof 无效时 host 直接 `deny(PROOF_INVALID)`；
- 能力阈值按 `docs/01` §6 表执行（iOS 先于 Safari 判断），规则在 `packages/core/src/capability.ts` 有单测；
- SAS 的 60 s 未确认超时已实现：guest 与 host 各自计时，超时置 `error`、关闭数据通道/房间并提示重新配对；
  e2e 用 dev-only `?sasTimeoutMs=` 覆盖缩短等待（默认仍 60 s）。
