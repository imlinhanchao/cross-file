# ADR 0010 — 房间内任意互传（Any-to-Any Room）

状态：已采纳（2026-11-26）

## 背景

现行设计（`docs/01` D6/D7/D8/D9/D18）默认「发起方 = 发送方」：发起方建房间、当会话宿主、必须在线（D7/D8）；
接收方扫码加入、只收（D6）；同一个发送方一次只服务一个接收方（D9/D18）。协议 v1（`docs/02`）按这个前提长出来：

- 信令只路由「发送方 ↔ 接收方」：接收方之间互不可见，接收方发出的 `signal` 只能以哨兵 `"host"` 寄给发送方
  （`packages/signaling/src/server.ts`）；服务端房间对象只有 `hostPeerId + guests[]`。
- 传输栈分两半：发送方（文件选择、manifest、分片）与接收方（`ChunkReceiver`、保存层）各在一端，没有对调能力。
- roomKey 由发起方生成，加入 proof 与 6 位码路径的密钥分发都以发起方为信任根。
- 续传由发送方重连驱动；接收方 socket 一断就被移出房间，没有 60 秒重连窗口。

真实需求是反过来的：接收方也要能把文件发回去；进一步，进入同一个房间的设备应当能两两互传。
这不是给协议加一个方向，而是把「房间」从「发送方 + 若干接收方」改成「管理员 + 成员」，再把传输方向放开。

## 决定

1. 房间模型改为「管理员 + 成员」；目标是房间内任意两台设备互传，**分两阶段交付**：
   阶段 1（本次）管理员↔成员任意方向、同一对设备串行；阶段 2（本次不实现）任意成员之间懒建连 mesh。
2. 权限：管理员独占批准加入、移除成员、关房与邀请；成员可以收发、改名。邀请权是 UI 约束，不是密码学约束
   （见「安全注记」）。
3. 全端对称：Web、桌面壳、手机壳都能发也能收；「零安装接收」承诺不变，发送只是附加能力。
4. 显示名：默认 `平台 · 4 位代号`（如 `MacBook · 7K2F`），入房前与会话中都可改，1–16 个 Unicode 码点，重名自动加
   `-2` 后缀；昵称本地记忆（Web 与原生壳 webview 的 `localStorage`），跨房间复用，设置里可「忘记」。
5. 协议升 v2，不兼容旧端：`PROTOCOL_VERSION = 2`；信令服务器对 v1 连接回 `VERSION_MISMATCH`，前端提示刷新
   页面；不写兼容层。
6. 信令：S 广播成员列表 `members`（`id` / `name` / `caps` / `isAdmin` / `state`），并在任意两个成员之间转发
   `signal`；S 仍零存储、不落盘、不设 cookie/埋点。
7. 传输授权：发送方选文件 → 接收方 `accept` 即授权，不需要管理员逐次批准；每次传输都要接收方确认；
   阶段 2 可加「本房间内自动接收」开关（默认关）。
8. 并发：同一对设备之间串行（方向不限），不同对之间可并发；同一对的两个方向用 `transferId` 隔离
   `fileId` 命名空间。
9. 续传：对称——每对由**接收方**发 bitmap、**发送方**补片，窗口 60 秒；成员也获得 60 秒重连窗口
   （`rejoinToken`），不再「一断即被移除」。
10. 连接角色：阶段 1 由管理员固定发起 offer（沿用现有发送方/接收方 offer 结构）；阶段 2 每对设备按 peerId
    字典序决定 offerer，支持懒建连。
11. 房间生命周期：阶段 1 保持 D7/D8（显式「结束房间」立即销毁；管理员 socket 断开时房间保留到 TTL，
    60 秒内可凭 `rejoinToken` 重连，不因窗口到期自动散房）；阶段 2 管理员离开时自动把管理权移交给最早加入的
    在线成员，最后一人离开才销毁（见 `docs/01` D7/D8/D24）。
12. 上限：成员数保持 D6（官方实例 2 个、自托管默认 4 个，不含管理员）；单文件 500 MB；**每个发送方**单会话
    2 GB；接收方仍按 D16 能力与配额校验。
13. UI：阶段 1 合并统一 Room 页（取消 Host/Guest 两页与角色绑定入口），首页给「创建房间 / 加入房间」两个入口，
    「房主」改称「管理员」；`design/screens` 重画 6 张（见 `docs/04` §17）。
14. 隐私：S 可见元数据新增「房间成员数、显示名、平台、谁在跟谁建立连接」（不落盘）；`docs/01` §5、`/privacy`
    页与 README 同步改写。
15. 验收：原 AC1–AC9 保持，新增 AC10–AC15（双向、排队、双向续传、统一 Room 页与昵称、版本门禁、零存储）；
    阶段 2 不在本次实现范围。

## 协议增量（v2）

细节以 `docs/02-protocol.md` 为准，这里只列与 v1 的差异。

**信令消息（`/v1/ws`，`PROTOCOL_VERSION = 2`）**

| 方向 | type | 关键字段 | 说明 |
|---|---|---|---|
| C→S | `hello` | `v, clientCaps` | 建连第一条；`v !== 2` 回 `VERSION_MISMATCH` |
| C→S | `create` | `roomId, caps, name` | 创建房间，创建者即管理员 |
| C→S | `join` | `roomId, caps, nonce, proof?, rejoinToken?` | 带 `rejoinToken` 时是 60 秒内重连，不重新审批 |
| C→S | `approve` / `deny` / `remove` | `memberId, reason?` | 仅管理员 |
| C→S | `signal` | `to, payload` | `to` 为任意 `memberId`；S 按成员表路由并填 `from` |
| C→S | `profile` | `name` | 改显示名；S 校验长度/查重后广播 `members` |
| C→S | `heartbeat` | `roomId` | 每 20 秒；阶段 1 仅管理员心跳续期房间（沿用 v1），阶段 2 任一成员 |
| C→S | `close` | `roomId` | 仅管理员 |
| S→C | `created` | `roomId, code, selfId, name, members, rejoinToken, turn?` | 管理员建房回执 |
| S→C | `join_request` | `memberId, name, caps, nonce, proof?` | 转发给管理员等待批准 |
| S→C | `join_ok` | `roomId, selfId, name, members, rejoinToken, turn?` | 含完整成员列表（每个成员都带 caps，供 D16 计算） |
| S→C | `join_rejected` | `code, reason` | 拒绝/超时/房间不存在 |
| S→C | `members` | `members[]` | 成员加入/离开/离线/改名时广播给所有人 |
| S→C | `signal` | `from, payload` | 透传 offer/answer/candidate |
| S→C | `member_left` | `memberId` | 只发给管理员，且仅在成员真正被移除时（离线 60 s 到期或被移除）；offline 状态由 `members.state` 表达 |
| S→C | `room_closed` | `reason` | `admin_close` / `ttl` / `error`；阶段 2 的移交语义见 D24 |
| S→C | `turn` / `error` | 见 v1 | 错误码新增 `VERSION_MISMATCH`、`NOT_ADMIN`、`BUSY`（`BUSY` 用于同对串行排队） |

`MemberInfo = { id, name, caps, isAdmin, state: "joined" | "offline" }`。

**传输标识（transferId）**

- 格式 `<senderMemberId>:<counter>`，`counter` 每个成员在房间内从 1 单调递增；
- `manifest` / `accept` / `bitmap` / `progress` / `done` / `ack` / `error` 全部带 `transferId`；
- 两个方向各自编号，互不冲突；同一对设备同一时刻只有一个 `transferId` 处于活动状态（决定 8）。

**密钥派生（v2）**

```
sessionKey = HKDF-SHA256(roomKey, salt=roomId, info="crossfile/v2/session", 32B)
fileKey    = HKDF-SHA256(sessionKey, info="crossfile/v2/file:" || transferId || ":" || fileId, 32B)
SAS        = HKDF-SHA256(pairs, info="crossfile/v2/sas", 4B)   // 仅 6 位码路径
```

`transferId` 进入 `fileKey` 的 info，因此两个方向的同号 `fileId` 不会共享密钥/nonce 空间。

**对称续传**

- 接收方在重建的 ctrl 通道上先发 `bitmap { transferId, fileId, bits }`，发送方只补缺失分片；
- 60 秒窗口内双方都可用 `rejoinToken` 回到房间（成员不再「一断即被移除」）；
- `PeerConnection` 重建：阶段 1 固定由管理员发起 offer；阶段 2 按 peerId 字典序。

**版本门禁**

- 服务端在 `hello`/`create`/`join` 校验 `v`，不是 2 就回 `VERSION_MISMATCH` 并关闭连接；
- 前端收到该错误显示 `copy.versionOutdated` + `copy.refreshPage`，不静默半死。

## 两阶段路线

| 阶段 | 范围 | 交付判据 |
|---|---|---|
| 阶段 1（本次） | v2 协议全量字段（`members` / `profile` / `transferId` / 任意成员 `signal` 的形状），但只启用「管理员↔成员」；统一 Room 页；成员 60 秒重连；每对串行；对称续传 | AC10–AC15 + 原有 AC1–AC9、门禁全绿 |
| 阶段 2（未实现） | 任意成员间懒建连 mesh、任意成员互传 UI、管理权自动移交、自动接收开关、人数实测调参 | 另开 ADR / 计划补充 |

阶段 1 先把协议形状定死（而不是先做 1:1 再改协议），因为 S 的成员表与任意路由是房间模型的核心，改两次不划算；
阶段 1 的客户端状态模型也直接按成员列表写，避免返工。

## 安全注记

1. **邀请权是 UI 约束，不是密码学约束。** QR 路径的成员本来就持有 `roomKey`，理论上可以自己伪造
   `proof = HMAC(roomKey, "join:" || roomId || nonce)`，让信令服务器转发一条合法的加入请求；最终门禁仍是
   管理员逐个批准。要变成硬约束，需要改成「管理员签发一次性邀请票据」，本次不做（见 `docs/security.md`）。
2. **S 新增可见元数据**：房间成员数、显示名、平台、谁在跟谁建立连接。S 本来就持有房间成员表（否则无法转发
   信令），新增的只是显示名与公开的成员列表；仍然不落盘、不设 cookie、不埋点。对外隐私文案已同步改写
   （`docs/01` §5、`/privacy`）。
3. **成员间共享 roomKey**（QR 路径）：成员之间的加密不依赖「只有双方知道密钥」，保密性由 WebRTC 数据通道
   本身承担；成员仍无法读取其他成员的传输内容（SDP 信令由 S 定向转发，不含内容）。
4. **昵称是首个本地持久化的用户数据**：只存显示名，不存房间、密钥或历史，可随时清除；与 D14「无账号」不冲突。

## 验证

本次只交付文档与隐私文案，协议实现与验收在阶段 1 落地时补：

- 单测：`protocol.test.ts`（v2 消息 schema、版本门禁、`transferId` 解析）、`crypto.test.ts`（v2 派生、
  跨 transfer 密钥隔离）。
- e2e：AC10–AC15（见 `docs/06-acceptance.md`，先记「待验」）。
- 门禁：`pnpm gate` + `pnpm e2e` 全绿；`tests/audit/zero-storage.sh` 两种模式仍 PASS（`members`/`profile`
  广播只进内存）。

## 后果

- **旧端不兼容**：必须同时部署新 signaling 与前端；部署窗口内旧页面会收到 `VERSION_MISMATCH` 并提示刷新。
- **S 房间状态机重写**：`hostPeerId/hostSocket` 变成 `adminMemberId + members[]`，加入审批、离线 60 秒窗口、
  `rejoinToken`、任意成员路由、显示名校验都要补测试；`server.test.ts` 覆盖面显著扩大。
- **Web UI 合并重写**：`HostPage` / `GuestPage` 合并为 Room 页，`store` 从房主中心结构改成成员列表结构；
  `design/screens` 5 张旧稿作废，按 `docs/04` §17 重画 6 张。
- **阶段 2 未实现**：当前只有「管理员↔成员」能互传；成员之间互传、管理权移交、自动接收要等阶段 2。
- **文档/验收/协议同步更新**：`docs/01` D6–D9/D18、新增 D19–D24；`docs/02` 升 v2；`docs/06` 增 AC10–AC15；
  `docs/security.md`、README、`/privacy`、`copy.ts` 同步。
- **风险**：成员数上限未随 mesh 调整（先保持 D6）；显示名带来用户输入，需转义（React 默认转义）与长度/重名
  校验；`profile` 广播可能被滥发，需限频（沿用信令限流）。
