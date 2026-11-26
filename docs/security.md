# 安全映射：威胁 → 机制 → 测试

> 配套：`docs/02-protocol.md` §2（威胁模型）、§10（实现注记）；`SECURITY.md`（报告流程）。
> 目的：让每条安全承诺都能指到一个实现与一个自动化测试。

## 1. 资产与信任边界

| 资产 | 对服务器 S / 中继 T 的保证 | 实现 | 测试 |
|---|---|---|---|
| 文件内容 | 不可读 | AES-256-GCM 分片（`core/src/crypto.ts`），TURN 只见 DTLS 密文 | `crypto.test.ts`（篡改/重放/换 nonce 必失败）、AC2 中继 e2e |
| 文件名/大小/清单 | 不可见 | manifest 走 ctrl 数据通道，S 不参与 | 代码审查 + e2e（S 无访问日志） |
| roomKey | 不可见 | 只在 fragment / SAS 后的 ctrl 消息 | `crypto.test.ts` proof、code-sas e2e |
| 元数据（IP/时长/字节量） | **可见**，文档写明 | — | 隐私页 `/privacy`、`docs/01` §5 |
| 元数据（成员数/显示名/平台/连接关系，v2） | **可见**，文档写明 | S 需成员表才能路由信令；只进内存、不落盘、不进日志 | 隐私页 `/privacy`、`docs/01` §5、`zero-storage.sh` |
| 连接内容完整性 | 可检测 | 逐片 AAD + 全文件 SHA-256 双向 | `transfer.test.ts`、所有 e2e 的哈希断言 |

## 2. 恶意信令服务器的攻击面（docs/02 §2.3）

| 攻击 | 机制 | 测试 |
|---|---|---|
| 注入假接收方 | 加入需 `proof = HMAC(roomKey, "join:"‖roomId‖nonce)`，S 无 roomKey；管理员校验失败即 deny | `crypto.test.ts`「伪造 roomKey 的 proof 被拒」；管理员 `join_request` 分支 |
| 伪造邀请加入请求（v2） | QR 路径成员持有 roomKey，可生成合法 `proof`；最终门禁是管理员逐个批准（邀请权是 UI 约束，见 ADR 0010 安全注记） | 管理员 `join_request` 审批分支；`docs/adr/0010-any-to-any-room.md` |
| 成员列表/显示名被篡改 | 显示名由 S 校验（1–16 字符、去控制字符、房内查重）后随 `members` 广播；客户端按 `memberId` 识别，显示名只用于展示 | signaling 单测（待补）、前端转义审查 |
| MITM 替换 SDP 指纹 | QR 路径：AES-GCM 认证失败即中止；6 位码路径：4 emoji SAS | `code-sas.spec.ts`（SAS 不一致无 UI 路径可通过）、`crypto.test.ts` SAS 对称/变更检测 |
| 重放/冒用 | roomId 随机 16 B、roomKey 每会话新生成、房间 ≤30 min | `ids.test.ts`、signaling 房间测试 |
| 主动掉线/DoS | UI 明确报错，不假装成功 | `resume` e2e、错误文案映射 `errorText` |
| 篡改分片顺序/长度 | AAD = fileId‖seq‖len；接收端校验每片长度 | `transfer.test.ts`（乱序、重复、越界 seq） |

## 3. 客户端与部署面

| 面 | 措施 | 验证 |
|---|---|---|
| XSS/内容注入 | React 默认转义；唯一 `dangerouslySetInnerHTML` 用于本地生成的内联 SVG（图标/二维码） | 代码审查 |
| 点击劫持 | 生产静态托管 `frame-ancestors 'none'` | `static.test.ts` 断言 CSP |
| Referer 泄漏密钥 | `Referrer-Policy: no-referrer` | `static.test.ts`、`curl -I` 验收命令 |
| 第三方依赖外连 | CSP `connect-src 'self' ws: wss:`、无分析 SDK、无第三方字体/CDN | `static.test.ts`、代码审查 |
| 服务器落盘 | 只读根文件系统、非 root、无 volume、无 DB、无访问日志 | `zero-storage.sh` 两种模式 |
| 容器权限 | `cap_drop: ALL`、`no-new-privileges`、`read_only` | `zero-storage.sh --container` 断言 |
| 能力降级/欺骗 | 接收端按自身 caps 判定，超配额/硬上限拒绝并给下一步 | `quota-reject.spec.ts`、`capability-warn.spec.ts` |
| 环境不支持 WebRTC | 启动预检，直接阻断而非失败握手 | `webrtc-missing.spec.ts` |
| 显示名（用户输入） | React 默认转义；客户端 1–16 个 Unicode 码点、去控制字符、房内查重；S 不把显示名写日志 | 代码审查 + signaling 单测（待补） |
| 显示名本地记忆 | 只存昵称（Web 与原生壳 webview 的 `localStorage`），不存房间、密钥或历史；设置里可「忘记」 | 代码审查、`/privacy` |
| 桌面壳保存路径穿越 | 文件名清洗 + 同名去重（Rust 侧单测） | `cargo test`（desktop/mobile） |

## 4. 已知残余风险（不隐藏）

1. **匿名中继的滥用**：官方实例会转发密文流量，需要 ToS/举报/关停手段（部署清单 §7）；
2. **无前向保密/无棘轮**：每个会话一把新 roomKey，但会话内没有 per-message ratchet；
3. **元数据可见**：IP、房间时长、中继字节量对服务器可见；v2 起还包括房间成员数、显示名、平台，以及谁在
   跟谁建立连接（不落盘、不进日志，但仍是可见元数据）；
4. **终端被攻破**：端到端加密不防受控终端；
5. **Safari/iOS 保存仍未在生产级真机验证**（见 `docs/06-acceptance.md` AC4）；
6. **v1 未做外部安全审计**：以上靠设计 + 自动化测试，正式发布前建议第三方审计（尤其 crypto 与信令状态机）。
7. **邀请权只是 UI 约束**：QR 路径的成员持有 roomKey，可伪造合法的加入 proof 让 S 转发请求；实际门禁是
   管理员的逐个批准。要做成密码学硬约束需「管理员签发一次性邀请票据」，本次未做（ADR 0010）。
8. **成员间共享 roomKey**（QR 路径）：成员之间的传输保密性依赖 WebRTC 数据通道本身，而不是「只有双方知道
   密钥」；数据通道之外的成员看不到内容，但 S 与任何持有 roomKey 的成员在密钥层面是等价的。
9. **显示名是首个本地持久化的用户数据**：只存昵称、可随时清除，与密钥和房间状态无关；但它是可识别的用户
   输入，隐私页已写明。

## 5. 如何复跑安全相关测试

```bash
pnpm test                        # crypto/transfer/protocol/ids/capability（118 个）
pnpm e2e                         # 端到端：传输、续传、SAS、房间销毁、配额拒绝、无障碍
E2E_RELAY=1 … pnpm exec playwright test tests/e2e/ac2-relay.spec.ts
bash tests/audit/zero-storage.sh
SKIP_BUILD=1 bash tests/audit/zero-storage.sh --container
```
