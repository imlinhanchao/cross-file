# CrossFile 协议设计 v2

> 配套：`01-design.md`（决策，含 D19–D24）｜`03-roadmap.md`（工程）｜`adr/0010-any-to-any-room.md`（本版由来）
> 目标读者：实现者。所有字段、状态机、错误码以此为准；未写到的都算「未定义」，不得自行发明。
> 变更：v2 把房间从「发送方 + 接收方」改成「管理员 + 成员」，放开传输方向；协议不兼容 v1（`PROTOCOL_VERSION = 2`）。

---

## 1. 术语与常量

| 名称 | 说明 |
|---|---|
| `A` | 管理员（admin），原「房主 / 发送方」；创建房间，独占批准/移除/关房/邀请 |
| `M` | 成员（member），原「接收方」；可收发、可改名 |
| `S` | 信令服务器（signaling） |
| `T` | TURN 中继 |
| `roomId` | 16 字节随机数，base32 编码 26 字符，可公开 |
| `roomKey` | 32 字节随机数，只在 fragment / SAS 认证后的通道出现 |
| `memberId` | 连接内随机 8 字节，由 S 分配（v1 的 `peerId`/`guestId` 统一为它） |
| `name` | 设备显示名，默认 `平台 · 4 位代号`，1–16 个 Unicode 码点，房间内唯一 |
| `transferId` | 传输标识，`<senderMemberId>:<counter>`，同一对设备同一时刻只有一个活动值 |
| `chunk` | 明文分片，默认 64 KiB，可升级至 256 KiB |

常量：`PROTOCOL_VERSION = 2`；`CHUNK_MIN = 64 KiB`；`CHUNK_MAX = 256 KiB`（受 `sctp.maxMessageSize` 限制）；
`HWM = 8 MiB`（发送高水位）；`LWM = 2 MiB`；`RECONNECT_WINDOW = 60 s`（`rejoinToken` 有效期，双方都适用；
窗口到期不等于房间销毁，房间保留到 TTL）；
`ROOM_TTL = 30 min`；`HEARTBEAT = 20 s`（阶段 1 仅管理员心跳续期房间，沿用 v1；阶段 2 任一成员）；`TURN_TTL = 1 h`；
`MAX_MEMBERS`：官方实例 2、自托管默认 4（不含管理员；实现里沿用 `maxGuests` 选项，语义为成员上限）。

---

## 2. 威胁模型与信任边界

### 2.1 参与方与能力假设

- `S` 和 `T` 被当作**诚实但好奇，甚至可能是恶意**：它们可以看到 IP、房间成员列表、显示名、平台、
  连接关系、房间存在时间、字节量，可能篡改信令、注入假成员、主动掉线。
- 网络上的被动攻击者只能看到加密流量。
- 浏览器/App 终端本身是可信的（不防终端被攻破）。
- 传输层：到 `S` 用 `wss://`，到 `T` 用 `turns://`；数据通道本身是 DTLS-SCTP 端到端加密。

### 2.2 承诺与不可避免的暴露

| 资产 | 对 S/T 保证 | 机制 |
|---|---|---|
| 文件内容 | 不可读 | 应用层 AES-256-GCM；TURN 只转发 DTLS 密文 |
| 文件名、大小、清单 | 不可见 | 清单走数据通道，S 不参与 |
| roomKey | 不可见 | 只在 URL fragment / 数据通道 |
| 元数据：IP、房间时长、字节量 | **可见** | NAT 穿透的物理成本，写入隐私说明 |
| 元数据：成员数、显示名、平台、谁连谁 | **可见**（v2 新增） | S 必须持有成员表才能路由信令；不落盘、不埋点 |
| 连接内容完整性 | 可检测篡改 | SAS（6 位码路径）/ fragment 密钥（QR 路径） |

### 2.3 针对恶意 S 的攻击面

1. **注入假成员**：QR 路径要求加入时附带 `proof = HMAC-SHA256(roomKey, "join:" || roomId || nonce)`；
   S 不知道 roomKey，无法伪造。此外管理员仍需人工批准。
2. **MITM 信令（替换 SDP 指纹）**：QR 路径密钥在带外，AES-GCM 解密失败即中止；6 位码路径靠 4 emoji SAS
   绑定双方 DTLS 指纹。
3. **重放/冒用**：房间短命（≤30 分钟）、roomKey 每次会话新生成、`roomId` 不可预测。
4. **DoS / 掉线**：无法防；UI 必须把「连接失败」讲清楚，而不是假装成功。
5. **成员伪造邀请**（v2 新增风险，UI 约束）：QR 路径的成员持有 roomKey，理论上可伪造 `proof` 让 S 转发
   候选加入请求；最终门禁是管理员的逐个批准。要变成密码学硬约束需「管理员签发一次性邀请票据」，本次未做
   （见 `adr/0010-any-to-any-room.md`「安全注记」与 `docs/security.md`）。

---

## 3. 房间与信令协议

### 3.1 传输

WebSocket（`wss://<host>/v1/ws`），消息为 JSON 文本帧；大于 64 KiB 的消息拒绝。所有消息带 `v`、`type`、`id`
（客户端消息序号，用于回执）。`v` 必须是 2，否则 S 回 `VERSION_MISMATCH` 并关闭连接。

### 3.2 消息表（v2）

**客户端 → S**

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `v, clientCaps` | 建连后第一条；上报自身能力（§5） |
| `create` | `roomId, caps, name` | 创建房间；创建者即管理员（`isAdmin=true`） |
| `join` | `roomId, caps, nonce, proof?, rejoinToken?` | 申请加入；QR 路径必须带 `proof`；带 `rejoinToken` 时为 60 s 内重连（不重新审批，无效/过期回 `ROOM_NOT_FOUND`，msg `rejoin token is invalid or expired`）；默认显示名由 S 用 `defaultDisplayName(caps)` 生成，`join_request`/`join_ok` 下发，客户端有本地记忆名时在 `join_ok` 后立即发 `profile{name}` 覆盖 |
| `approve` | `memberId` | 管理员批准某成员（仅管理员） |
| `deny` | `memberId, reason` | 管理员拒绝（仅管理员） |
| `remove` | `memberId` | 管理员移除成员（仅管理员） |
| `signal` | `to, payload` | 透传 WebRTC 信令：`{k:"offer"|"answer"|"candidate", sdp?, candidate?}`；`to` 为任意 `memberId` |
| `profile` | `name` | 改显示名；客户端 1–16 个 Unicode 码点；S 校验后广播 `members`；**限流 10 次/60 s**，超限回 `RATE_LIMITED` |
| `heartbeat` | `roomId` | 每 20 s 一次；**阶段 1 仅管理员心跳续期房间**（沿用 v1），阶段 2 任一成员 |
| `close` | `roomId` | 管理员主动结束房间（仅管理员） |

**S → 客户端**

| type | 字段 | 说明 |
|---|---|---|
| `created` | `roomId, code, selfId, name, members, rejoinToken, turn?` | 房间创建成功；`members` 含自己；可选附 TURN 凭据 |
| `join_request` | `memberId, name, caps, nonce, proof?` | 转发给管理员等待批准 |
| `join_ok` | `roomId, selfId, name, members, rejoinToken, turn?` | 批准后发给成员，附完整成员列表（每个成员带 caps）与 TURN 凭据 |
| `join_rejected` | `code, reason` | 拒绝/超时/房间不存在（`code` 见 §3.7） |
| `members` | `members[]` | 成员加入/离开/离线/改名时广播给房间内所有人 |
| `signal` | `from, payload` | 透传；`from` 由 S 填写，客户端不可伪造 |
| `member_left` | `memberId` | **只发给管理员**，且仅在成员真正被移除时发送（离线 60 s 到期或被 `remove`）；`offline` 状态由 `members` 的 `state` 表达，不单独发消息 |
| `room_closed` | `reason` | `admin_close` / `ttl` / `error`（阶段 2 的管理权移交见 D24） |
| `turn` | `uris, username, credential, ttl` | 按需下发 |
| `error` | `code, msg` | 见 §3.7 |

`MemberInfo = { id, name, caps, isAdmin, state: "joined" | "offline" }`；`members` 永远是全量快照（不是增量）。

### 3.3 房间状态机（S 侧，全部在内存）

```
created ──join_request──▶ awaiting_approval ──approve──▶ joined
   │                           │                          │
   │                           └──deny/timeout──▶ removed │
   │                                                      ├──member socket lost──▶ offline（60 s）
   │                                                      │        └──rejoin(rejoinToken)──▶ joined
   │                                                      └──60 s──▶ removed（member_left 仅发管理员）
   ├──admin socket lost──▶ admin_offline（admin state=offline，广播 members；房间保留）
   │        └──admin rejoin(rejoinToken ≤60 s)──▶ created
   │        └──不自动散房：保留到 ROOM_TTL(30 min) 统一清理
   └──ttl(30 min 无活动)──▶ closed
```

- 房间对象只存：`roomId, adminMemberId, adminSocket, members[], createdAt, lastActivity, code`。
  **不存 IP、不存 UA 原文、不写磁盘。**
- `caps` 与显示名仅在内存中转发，S 不记录（不进日志）。
- 管理员 socket 断开：置 `adminOffline=true`、广播 `members`（管理员 `state: "offline"`），房间保留到
  `ROOM_TTL`；**60 秒只是 `rejoinToken` 的重连窗口，到点不自动散房**。
- 阶段 2：`admin_offline` 超过 60 s 后把 `isAdmin` 移交给最早加入的在线成员，广播 `members`
  （见 `docs/01` D24）；本次不实现。

### 3.4 加入时序（QR 路径，推荐）

```
M 打开 /r/<roomId>#<roomKey>
M → S   join {roomId, caps, name, nonce, proof}
S → A   join_request {...}
A → S   approve {memberId}
S → M   join_ok {roomId, selfId, name, members, rejoinToken, turn}
S → 全员 members（含新成员）
A ↔ M   经 S 透传 offer/answer/candidate（A 发起 offer）
A ↔ M   PC 连接，开两个数据通道：ctrl（JSON）、data（二进制）
M → A   ctrl: hello {caps}
A 校验 proof，加入审批名单
```

### 3.5 加入时序（6 位码路径）

```
M 输入 6 位数字码 → S 用短码映射到 roomId（短码 10 分钟有效、单次使用）
M → S   join {roomId, caps, name, nonce}   // 无 proof
（同 3.4，但批准后 A 不立即发文件）
A ↔ M   数据通道建立 → 双方各自计算 SAS（§4.5）→ 屏幕显示 4 emoji
A/M     人工比对，两侧都点「一致」→ A 通过 ctrl 发送 roomKey（32B）→ M 用 HMAC 验证
任一侧点「不一致」或 60 s 未确认 → 中止，房间不受影响
```

### 3.6 反向传输时序（v2 新增，两个方向对称）

```
任一方 P1（可以是管理员或成员），在已建立的 ctrl/data 通道上：
P1 → P2   ctrl: manifest {transferId, files[], totalSize, chunkNegotiation}
P2 → P1   ctrl: accept {transferId, fileIds}      // 收方接受即授权（D19）
P1 → P2   data: CHUNK 帧（fileId 属于该 transferId）
P1 → P2   ctrl: progress {transferId, fileId, seq}（每 100 片，仅 UI）
P1 → P2   ctrl: done {transferId, fileId, sha256, chunkCount}
P2 → P1   ctrl: ack {transferId, fileId, ok} / error
```

- 同一对设备同一时刻只有一个活动 `transferId`；另一方此时发起传输会收到 `busy`，排队等前一条 `ack` 后重试。
- 管理员与成员都可能处于发送侧；`roomKey` 已在加入阶段分发（QR 路径在 fragment，6 位码路径在 SAS 确认后），
  双向复用同一个 `sessionKey`，用 `transferId` 隔离密钥空间（§4.1）。

### 3.7 错误码

| code | 含义 |
|---|---|
| `ROOM_NOT_FOUND` / `ROOM_CLOSED` | 房间不存在/已结束 |
| `ROOM_FULL` | 成员数量已达上限（官方实例 2，自托管默认 4，不含管理员） |
| `VERSION_MISMATCH` | 协议版本不是 2（页面过旧） |
| `NOT_ADMIN` | 该操作仅管理员可执行 |
| `PROOF_INVALID` | QR 路径 proof 校验失败（可能被 S 注入） |
| `SAS_MISMATCH` | 6 位码路径指纹不一致 |
| `TOO_LARGE` | 超过该接收端硬上限 |
| `CAPABILITY_RISK_DECLINED` | 接收方拒绝超软上限文件 |
| `HASH_MISMATCH` | 全文件 SHA-256 不一致 |
| `BUSY` | 同一对设备已有活动传输，请排队重试 |
| `TIMEOUT` | 握手或续传超时 |
| `PEER_GONE` | 对端断开且超过续传窗口 |
| `RATE_LIMITED` | 超过信令/中继频率限制（例如 `profile` 改名 10 次/60 s） |

---

## 4. 密钥、加密与完整性

### 4.1 密钥派生（v2）

```
roomKey   = 32B random (crypto.getRandomValues)           // 只在 fragment
joinProof = HMAC-SHA256(roomKey, "join:" || roomId || memberNonce)
sessionKey= HKDF-SHA256(roomKey, salt=roomId, info="crossfile/v2/session", 32B)
fileKey   = HKDF-SHA256(sessionKey, info="crossfile/v2/file:" || transferId || ":" || fileId, 32B)
fileSalt  = 4B random（每文件，随清单下发）
```

`transferId` 进入 `fileKey` 的 info：两个方向的同号 `fileId` 因此不共享密钥与 nonce 空间；同一传输重连后
`transferId`、`fileId`、`fileSalt` 不变，密文可逐字节复用。

### 4.2 分片加密（AES-256-GCM）

- 每片明文 `P`（≤ CHUNK），密文 = `AES-GCM(fileKey, nonce, P, aad)`，tag 16B 附在密文尾。
- `nonce = fileSalt(4B) || chunkSeq(8B, big-endian)` → 12B，每文件每片唯一。
- `aad = fileId(2B) || chunkSeq(4B) || len(4B)` → 防重排、防截断、防错位；跨传输重放由 `fileKey` 隔离。
- 每片独立认证：缺片、乱序、篡改单独立即可发现。

### 4.3 清单（manifest）

```
{
  v: 2,
  transferId: "<senderMemberId>:<counter>",
  files: [
    { id: 1, name: "demo.mp4", size: 367001600, mime: "video/mp4",
      chunk: 65536, chunkCount: 5600, salt: <base64 4B> }
  ],
  totalSize: ...,
  chunkNegotiation: { min: 65536, max: 262144 }
}
```

实际分片大小取双方 `sctp.maxMessageSize` 与 `chunk` 的较小者，双方在 `hello` 中协商后固定，中途不变
（续传时沿用原值；若对端重连后 maxMessageSize 变化，仍用旧值，只允许原值 ≤ 新上限）。

### 4.4 全文件校验

- 发送方在发送过程中用增量 SHA-256（`@noble/hashes`，避免把 500MB 攒进内存）计算明文摘要；结束时
  `ctrl: done {transferId, fileId, sha256}`。
- 接收方边收边算，`done` 到达后比对；不一致 → `error HASH_MISMATCH`，该文件判定失败（允许重试一次整文件）。

### 4.5 SAS（6 位码路径）

```
fpLocal   = SHA-256(DTLS 本地证书指纹)      // 来自 SDP a=fingerprint
fpRemote  = SHA-256(SDP 中对方的 a=fingerprint)
pairs     = sort([fpLocal, fpRemote])
sasBits   = HKDF-SHA256(concat(pairs), info="crossfile/v2/sas", 4B)
emoji[i]  = EMOJI_64[ (sasBits[i] >> 2) & 0x3F ]   // 4 个 emoji，24 bit
```

双方必须显示相同 4 个 emoji；不一致意味着 S 可能做了中间人。反向传输复用已认证的通道，不再单独比对 SAS。

### 4.6 密钥生命周期

- 房间创建时生成；管理员点「结束房间」/房间过期/页面关闭 → 丢弃引用并尽力清零（JS 无法保证物理清零，
  原生壳层额外覆写）。
- 不做密钥持久化，不进 localStorage/IndexedDB。**显示名是唯一本地持久化的用户数据**，与密钥无关。

---

## 5. 能力包与动态限制（D16）

`caps` 由每个成员在 `hello` / `create` / `join` 上报，S 通过 `members` 广播给房间内所有人（每个发送方都要
按接收方的 caps 算上限）：

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

发送方规则（`packages/core/src/capability.ts`，可配置）：

1. `nativeShell === true` → 500/500
2. `fsAccess === true && uaFamily in {chrome,edge}` → 500/500
3. `uaFamily in {safari,firefox}` → 250/500
4. `platform === "ios"` → 100/500（强提示）
5. `platform === "android"` → 150/500
6. 其余/未知 → 150/500

流程：选文件后先按接收方算上限 → 超软上限弹提示并记录选择 → 超硬上限禁止勾选该接收方。接收方在
`accept` 前收到 manifest，按自身能力再校验一次，超软上限必须二次确认，超硬上限直接拒绝（`error TOO_LARGE`）。
v2 下发送方可能是任意成员，规则不变（仍然按**接收方** caps 计算）。

---

## 6. 传输协议

### 6.1 数据通道

- 每对设备一条 `PeerConnection`，上面开两个通道：`ctrl`（`ordered=true`、`reliable`，JSON 控制消息）与
  `data`（`ordered=true`、`reliable`，二进制分片帧）。
- 通道由 offerer 创建；阶段 1 offerer 固定为管理员，阶段 2 按 peerId 字典序（每对独立）。
- 通道开启顺序：先 `ctrl` 再 `data`；`data` 上禁止发控制消息。
- 双向共用一个 `ctrl`/`data`：**所有传输级 ctrl 消息都带 `transferId`**
  （`manifest` / `accept` / `bitmap` / `progress` / `done` / `ack` / `error` / `pause` / `resume`；只有
  `hello` 与 `key-ok` 等通道级消息不带），两个方向靠它区分。

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
`transferId` 不进帧头：它已经通过 `fileKey` 的派生参与认证，接收端按当前活动 `transferId` 归属分片。

### 6.3 流控

发送循环：`while (dc.bufferedAmount < HWM) send(frame)`；`bufferedAmountLowThreshold = LWM`，在
`onbufferedamountlow` 时继续。收到 `ctrl: pause` 立即停；收到 `ctrl: resume` 继续。

### 6.4 发送流程（单文件）

1. 发送方 → `ctrl: manifest {transferId, files}`（本次传输的所有待发文件）
2. 接收方 → `ctrl: accept {transferId, fileIds}`（或 `error` 拒绝某些文件）
3. 发送方按 `fileIds` 顺序逐文件发 CHUNK；每 100 片（≈6.5MB）发一次
   `ctrl: progress {transferId, fileId, seq}`（仅 UI）
4. 发送方 → `ctrl: done {transferId, fileId, sha256, chunkCount}`
5. 接收方校验 → `ctrl: ack {transferId, fileId, ok}` 或 `error HASH_MISMATCH`
6. 下一个文件；全部完成后该 `transferId` 关闭，同一对设备可以开始下一条（可能来自另一方向）

前置条件（QR 路径）：管理员收到成员的 `key-ok`（幂等就绪信号，见 §10.2）后才放行 `manifest`/发送；
6 位码路径在 `room-key` 之后收到 `key-ok` 再放行。

### 6.5 每对串行与排队（v2）

- 同一对设备同一时刻只有一个活动 `transferId`（两个方向共享这个限制）。
- 双方同时发起时按固定优先级裁决：阶段 1 **管理员方向优先**；阶段 2 按 `memberId` 字典序，小者优先。
- 非优先方收到对方 `manifest` 时若本侧已有活动传输，回 `ctrl: error {code:"BUSY", transferId}`；
  发起方本地排队，等当前传输 `ack` 后自动重试（UI 显示「已排队」）。
- 不同对设备之间互不影响，可并行传输。

### 6.6 续传状态机（对称）

```
        ┌────────── channel lost ──────────┐
        ▼                                  │
 [transferring] ──lost──▶ [paused] ──reconnect ≤60s──▶ [resuming] ──received bitmap──▶ [transferring]
        │                        │
        │                        └──>60s──▶ [failed]（对端可重新加入，新会话）
        └──done/err──▶ [completed/failed]
```

- 任一侧检测到 `data`/`ctrl` 通道关闭 → 本地置 `paused`，保留：已发/已收分片状态、`transferId`、文件 key、
  salt、分片大小。
- 60 s 内双方都可用 `rejoinToken` 回到房间（成员也不再「一断即被移除」）；`PeerConnection` 重建后，
  **接收方**先发 `ctrl: bitmap {transferId, fileId, bits}`，**发送方**只补缺失分片。
- **bitmap**：按分片序号，1 = 已收到；长度 = `ceil(chunkCount/8)` 字节，base64 传输。
  500MB/64KiB = 8000 片 → 1000 B → base64 约 1.4 KB。
- `chunkSeq` 不变，nonce 不变（因此不需要重加密）；续传期间不重发 manifest（双方内存里都有）；
  若接收方页面刷新（内存丢失）→ 无法续传，只能重新加入新会话。
- 阶段 1 的重建由管理员发起 offer；阶段 2 按 peerId 字典序决定 offerer。

### 6.7 ICE 路径选择与时序（D2）

1. `new RTCPeerConnection({iceServers: [stun(官方), turn(ephemeral)]})`
2. offerer 建 `data` channel 后 createOffer；对方 setRemote → createAnswer；Trickle ICE 透传。
3. ICE 自动按 candidate pair 优先级选路：host↔host（① 同网）> srflx↔srflx（④ 跨网打洞）> relay（⑤ 中继）。
4. 连接后 `pc.getStats()` 读取选中候选对 → 映射成 UI 标签「局域网直连 / 直连 / 中继」，并显示实时速率。
5. 不允许中途切路（v1）；路径变差只影响速度，不触发切换。

### 6.8 TURN 凭据

- S 用 coturn 的 `static-auth-secret` 模式签发：`username = "<expiryEpoch>:<memberId>"`，
  `credential = base64(HMAC-SHA1(secret, username))`，TTL 1 h。
- 仅在需要时下发（`created`/`join_ok`）；每个成员每次连接一份；官方实例按 IP 限频（内存计数，不落盘）。

---

## 6.9 接收端保存层（sink）

接收方在 `hello` 中按优先级上报 `saveStrategies`；发送方只负责传字节，保存策略由接收方决定，发送方不感知。
v2 下任何一端都可能成为接收方（Web 接收页、桌面壳、手机壳都一样）。

| 策略 | 条件 | 行为 |
|---|---|---|
| `native` | 原生壳 | 收到分片后按偏移直接写盘，支持续传随机写 |
| `fs` | `fsAccess === true`（Chromium 桌面） | `showSaveFilePicker` 取句柄，按分片流式写入 |
| `sw` | `swDownload === true`（Safari 15.4+，**自研**） | 页面经 `MessageChannel` 把解密分片推给同源 Service Worker；SW 用 `respondWith(new Response(stream, {headers:{"Content-Disposition":"attachment; filename=…"}}))` 交给浏览器下载管理器增量写盘 |
| `blob` | 兜底 | 分片攒进内存 `Blob`，完成时 `createObjectURL` + `<a download>`；超过 §5 软上限必须二次确认 |

约定：`sw` 要求页面与 Service Worker 同源（应用天然满足），下载 URL 带一次性随机 token、SW 校验后才返回流；
**不使用第三方 StreamSaver.js**（其在 Safari 会退回 Blob 兜底）。`sw` 失败自动降级 `blob`。

---

## 7. 服务端「零存储」实现约束

1. 房间、成员、速率计数器全部在进程内存（Map + 定时 sweep），**无数据库、无 Redis、无写文件**；
   v2 的成员表与显示名同样只在内存，广播完即无副本。
2. 日志：只允许 `error` 级、且不含 IP/UA/`roomId`/显示名原文；关闭访问日志；容器 stdout 仅启动信息。
   禁止把 `req` 对象整体打进日志。
3. 不设 cookie、不设指纹、不引第三方统计 SDK。
4. 优雅关闭时清空内存；崩溃重启丢失所有房间（可接受，符合「用完即走」）。
5. coturn：日志级别调至最低、日志写 tmpfs（内存），不落持久盘；`no-cli`；禁用 `no-loopback-peers` 之外
   的多余插件。
6. 自托管用 docker-compose：`signaling` + `coturn` 两个服务，一个 `.env` 配置域名/TURN secret。

---

## 8. 边界与失败处理

| 场景 | 行为 |
|---|---|
| 成员刷新页面 | 内存态丢失 → 当作离开；60 s 内可凭 `rejoinToken` 回房间，但接收状态丢失 → 只能重新传 |
| 管理员刷新/锁屏（阶段 1） | 房间保留；60 s 内凭 `rejoinToken` 重连，超过窗口不散房、保留到 ≤30 min TTL 统一清理（D7）；原生壳靠前台服务保活 |
| 管理员离开（阶段 2） | 管理权自动移交最早加入的在线成员，房间继续；最后一人离开才销毁（D24） |
| 传输中成员切后台 | 浏览器可能冻结数据通道 → 断流 → 60 s 续传窗口；超时失败并提示「请保持前台/装 App」 |
| 同一对设备双方同时发起传输 | 按 §6.5 优先级裁决，另一方 `BUSY` 排队；UI 显示「已排队」 |
| 文件被接收方拒绝 | `error CAPABILITY_RISK_DECLINED`，发送方 UI 显示原因 |
| 两个成员同时请求加入 | 顺序：管理员批准后进入队列，传输一次只服务一对设备 |
| 成员中途被移除 | 立刻断开，管理员 UI 标注「已移除」，队列跳过 |
| 中等质量网络丢包 | SCTP 重传兜底；进度可能停顿，UI 显示「重传中」而非误报完成 |
| 服务器重启 | 所有房间消失，客户端收到断线 → 提示「连接已失效，请重新创建房间」 |
| 旧版页面连接 | `VERSION_MISMATCH`，前端提示刷新页面（不静默失败） |
| 非管理员执行管理操作 | `NOT_ADMIN`，UI 隐藏入口（防御性返回同码） |

---

## 9. 待实测校准的协议参数

| 参数 | 初值 | 校准方式 |
|---|---|---|
| 分片大小 | 64 KiB（可升 256 KiB） | 局域网 500MB 实测吞吐对比 |
| HWM/LWM | 8 / 2 MiB | 同上，找吞吐拐点 |
| 续传窗口 | 60 s（双方） | 移动端锁屏/切后台实测 |
| 成员上限 | 官方 2 / 自托管 4 | mesh 阶段实测内存、电量、握手延迟 |
| 能力阈值 | §5 表 | 各平台 500MB 实测成功/失败边界 |
| 心跳间隔 | 20 s | 移动网络省电与房间存活平衡 |

---

## 10. 实现注记（v2 落地时补的定义，与上文同为事实源）

上文未定义的字段/行为在实现时按下列约定补全；代码位置一并给出，改动需同步本表。

### 10.1 信令消息

| 位置 | 补全 | 代码 |
|---|---|---|
| `created` | 增加 6 位数字短码 `code`（10 min、单次）与 `selfId`、`name`、`members`、`rejoinToken` | `packages/signaling/src/rooms.ts` / `shortcode.ts` |
| `join.roomId` | 允许直接传 6 位数字码；服务端在 schema 校验前映射为 roomId | `packages/signaling/src/server.ts` |
| `join_ok` | 携带全量 `members`（含每个成员的 caps），不再有单独的 `hostCaps/peerCaps` 字段 | 同上 / `packages/core/src/protocol.ts` |
| `signal.to` | v2 只接受真实 `memberId`；v1 的 `"host"` 哨兵不再保留（不兼容 v1） | 同上 |
| `rejoinToken` | S 生成 16 B base64url，随 `created`/`join_ok` 下发；60 s 内凭它重连同一身份，不走审批；无效/过期回 `ROOM_NOT_FOUND`（msg `rejoin token is invalid or expired`），客户端回到正常加入流程 | 同上 |
| 成员离线 | 成员 socket 断开 → `state: "offline"` 并广播 `members`；60 s 后从成员表移除，并**只向管理员**发 `member_left{memberId}`（无 `reason`） | 同上 |
| 管理员重连 | 同 `roomId` + `rejoinToken` 重连即恢复管理员身份；不再依赖「同 roomId 的 create 视为重连」 | 同上 |
| 房间清理 | 管理员 socket 断开不立即销毁：置 `adminOffline=true`、广播 `members`（admin `state:"offline"`），房间保留到 ≤30 min TTL；60 s 只是 `rejoinToken` 的重连窗口 | 同上 |
| `profile` | 客户端 1–16 个 Unicode 码点、去控制字符；服务端 schema 上限 64 作为防御性上限；房内去重（重名加 `-2`/`-3`）；**限流 10 次/60 s**，超限 `RATE_LIMITED`；通过后广播 `members` | 同上 |
| 加入时的显示名 | `join` 不带名字：S 按 `caps` 生成默认名（`platformLabel · 4 位代号`），`join_ok.name` 告知本人、`join_request.name` 给管理员；客户端有本地记忆时在 `join_ok` 后立刻发 `profile` 改名 | `packages/core/src/identity.ts` / `packages/signaling/src/server.ts` |
| 版本门禁 | `hello`/`create`/`join` 校验 `v === 2`，否则 `VERSION_MISMATCH` 后关闭 | 同上 |
| `heartbeat` | 阶段 1 仅管理员心跳续期房间；成员心跳被忽略（不报错，沿用 v1） | 同上 |
| 阶段 2 管理权 | 管理员离线超 60 s：把 `isAdmin` 交给最早加入的在线成员并广播 `members`，本次不实现 | 同上 |

### 10.2 控制通道（ctrl，JSON 文本帧）

统一形如 `{ "v": 2, "type": "<name>", ... }`：

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `caps` | 通道建立后双方各发一次（v2 双向对称，默认都支持 bitmap） |
| `manifest` | `transferId, files[{id,name,size,mime,chunk,chunkCount,salt}], totalSize, chunkNegotiation` | 只含该接收方被勾选的文件 |
| `accept` | `transferId, fileIds[]` | 接收方确认接收（即授权） |
| `bitmap` | `transferId, fileId, bits` | base64，1 bit/片，1=已收到；用于续传补片 |
| `progress` | `transferId, fileId, seq` | 发送侧每 100 片一次（仅 UI） |
| `done` | `transferId, fileId, sha256, chunkCount` | 发送完毕，附全文件摘要 |
| `ack` | `transferId, fileId, ok, error?` | 接收方校验结果；该 transfer 结束 |
| `error` | `code, msg, transferId?, fileId?` | 见 §3.7 错误码 |
| `pause` / `resume` | `transferId` | 接收端背压/流控 |
| `sas-confirm` | — | 6 位码路径：成员确认 4 emoji 一致 |
| `room-key` | `key, roomId` | 6 位码路径：管理员经 ctrl 下发 roomKey（base64url，32 B）与 roomId |
| `key-ok` | — | **就绪信号（幂等）**：成员已持有 roomKey、pair 就绪。QR 路径每次通道重建后成员都会发一次；6 位码路径在 `room-key` 之后发。管理员据此放行 `manifest`/发送 |

### 10.3 分片与续传

- 实际分片大小 = `min(chunk, sctp.maxMessageSize - 28)`（`effectiveChunkSize`），manifest 必须宣告该值；
- 发送方在发 manifest 前对每个文件**预先计算**全文件 SHA-256（续传时复用），发送循环本身不维护哈希；
- 续传：接收方发 `bitmap`，发送方只重发缺失片，`transferId`/`fileId`/`seq`/nonce 不变（密文可逐字节相同），
  随后重新发 `done`；
- 60 s 窗口内双方都以 `rejoinToken` 重连；阶段 1 由管理员重建 `PeerConnection`，阶段 2 按 peerId 字典序；
- `transferId` 格式 `${selfId}:<counter>`（`counter` 每个成员在房间内从 1 单调递增）；解析时只允许
  `[A-Za-z0-9_-]+:[1-9][0-9]*`；所有传输级 ctrl 消息都必须带它（`hello`/`key-ok` 等通道级消息除外）。

### 10.4 保存层实现状态

| 策略 | 状态 |
|---|---|
| `blob` | ✅ 已实现（默认兜底） |
| `native` | ✅ 已实现：Tauri 桌面/手机壳 `save_open/save_write(offset)/save_close/save_abort`，按偏移随机写 |
| `fs` | ✅ 已实现：`showSaveFilePicker` + 按偏移写（Chromium 桌面） |
| `sw` | ⏳ 未实现（M2 待做，见 ADR 0002；Safari/iOS 大文件保存依赖它） |

### 10.5 与上文的其他差异

- §5 的 `storageQuotaMB` 由每个成员在 `hello/create/join` 前用 `navigator.storage.estimate()` 探测后填入；
  `judgeFile` 在平台阈值之外还会用配额判断（超配额的 80% 警告、超配额拒绝），避免承诺存不下的文件；
- §2.3「管理员校验 proof」已落地：proof 无效时管理员直接 `deny(PROOF_INVALID)`；成员持有的 roomKey 使其
  也能生成合法 proof，最终门禁是管理员批准（ADR 0010「安全注记」）；
- 能力阈值按 `docs/01` §6 表执行（iOS 先于 Safari 判断），规则在 `packages/core/src/capability.ts` 有单测；
- SAS 的 60 s 未确认超时已实现：双方各自计时，超时置 `error`、关闭数据通道/房间并提示重新配对；
  e2e 用 dev-only `?sasTimeoutMs=` 覆盖缩短等待（默认仍 60 s）；
- v2 的「任意成员间 `signal`」路由到 `packages/signaling/src/server.ts`；成员表广播与昵称只在内存，
  不进日志（§7）；
- 阶段 2 的懒建连、任意成员互传、管理权移交、自动接收开关不在本版实现范围。
