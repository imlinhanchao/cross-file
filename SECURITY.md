# 安全策略

## 报告问题

请**不要**在公开 issue 里贴可复现的漏洞细节。用 GitHub Security Advisory（私有报告）或邮件
`security@<项目域名>`，附：影响版本/commit、复现步骤、影响面。我们会在 72 小时内确认，修复后致谢
（除非你要求匿名）。

## 范围

| 在范围内                                                         | 说明                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| 协议与加密实现（`packages/core/src/{crypto,protocol,transfer}`） | 密钥派生、AES-GCM 分片、SAS、proof、续传 bitmap、哈希校验           |
| 信令服务（`apps/signaling-go`）                                  | 房间状态机、审批/踢人、短码、限流、TURN 凭据、内嵌 TURN、静态托管头 |
| Web 端与壳（`apps/*`）                                           | 能力门禁、保存层、XSS/点击劫持、CSP/Referrer 泄漏                   |
| 部署（`infra/`）                                                 | 只读容器、零存储约束、反代配置                                      |

不在范围：终端设备被攻破、浏览器/内核自身漏洞、TURN 网络层 DDoS（属运营问题，见
`docs/deploy-official-instance.md` §7）、用户主动把带密钥的链接发给别人。

## 设计上的安全承诺（可验证）

1. **服务器不存内容**：文件只在数据通道里以 AES-256-GCM 密文流动；`tests/audit/zero-storage.sh` 用
   strace / 只读容器审计「无写盘、无数据库、无访问日志」。
2. **密钥不进服务器**：`roomKey` 只在 URL fragment 或 SAS 认证后的 ctrl 通道出现；页面带
   `Referrer-Policy: no-referrer`，fragment 不会经 referer 泄漏。
3. **可检测中间人**：QR 路径用带外密钥（proof + GCM 认证）；6 位码路径用 4 emoji SAS 绑定双方
   DTLS 指纹，不一致即中止。
4. **完整性**：逐片 AAD 绑定 `fileId/seq/len`，换片、重放、截断都会认证失败；传输结束再做全文件
   SHA-256 双向校验。
5. **诚实边界**：信令与中继能看到 IP、房间存在时长、中继字节量；官方实例在隐私说明与自托管文档
   中写明这一点，并提供自托管以便自行审计。

威胁模型与攻击面见 `docs/02-protocol.md` §2；每一条对应的自动化测试见
`docs/security.md` 的映射表。
