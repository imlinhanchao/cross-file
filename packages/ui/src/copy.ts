/** All user-visible copy (docs/04 §15). i18n hook point: one file, keyed strings. */
export const copy = {
  brand: "CrossFile",
  tagline: "扫码即传 · 端到端加密 · 服务器不存一个字节",
  privacyShort: "服务器不存一个字节。密钥只在这张码里。",
  privacyNote: "文件不经过服务器存储，房间结束后不留下任何副本",
  privacyLink: "隐私说明",
  roomTitle: "把文件发给房间里的成员",
  roomLead:
    "成员扫码或打开链接即可加入，无需安装任何东西。文件直接在你的设备和对方设备之间传输。",
  // 首页入口（design/screens/01-entry.html）：与 Room 页标题分开，避免入口页借用房间页文案
  entryTitle: "把文件直接送到对方的设备",
  entryLead:
    "不需要账号，不需要安装。房间只在传输期间存在，文件在两台设备之间端到端加密直传，服务器不保存任何内容。",
  entryFeatureBidirectional: "双向互传",
  joinDivider: "或加入别人的房间",
  // 入口页 EntryPage：页面内硬编码文案（web-agent 机械替换用，值逐字对齐页面）
  entryServerTitle: "服务器不存一个字节",
  entryEyebrow: "临时 · 大文件 · 用完即走",
  entryFeatureSecureBody: "AES-256-GCM 逐片认证，完成后双方比对 SHA-256。",
  entryFeatureServerBody: "只转发密文，不落盘；房间结束，密钥和状态一起销毁。",
  entryFeatureBidirectionalBody:
    "房间里的任何设备都能收发，不需要账号，不需要安装。",
  entryOpenSource: "开源 · 可自托管 · 文件不经过任何云盘",
  entryCreateHint:
    "你将成为管理员，可以邀请其他设备；房间里的任何人都能给你发文件。",
  entryInviteLinkLabel: "邀请链接",
  entryOpenButton: "打开",
  entryCodeRequired: "请输入 6 位数字码",
  entryLinkPasteRequired: "请粘贴完整邀请链接",
  entryLinkMissingKey: "链接不完整：缺少房间密钥（# 后的部分）",
  dropzone: "拖入文件，或点击选择",
  dropzoneHint: "单个文件 ≤ 500 MB · 每个发送方总计 ≤ 2 GB",
  emptyReceivers: "还没有成员加入。让对方扫码，或把 6 位码发给他。",
  joinCardTitle: "扫码加入",
  joinCardHint: "加入需你批准",
  orEnterCode: "或输入 6 位码",
  codeValidity: "10 分钟内有效",
  lanFirst: "局域网优先",
  pendingApproval: "请求加入",
  approve: "批准",
  deny: "拒绝",
  remove: "移除",
  endRoom: "结束房间",
  startSend: "开始发送",
  addFile: "添加文件",
  clear: "清空",
  copyLink: "复制链接",
  copied: "链接已复制",
  receiving: "正在接收",
  waitingHost: "等待对方",
  waitApproval: "等待对方批准…",
  approveHint: "成员已请求加入，确认后即可在房间内收发",
  transferInProgress: "正在传输",
  resumeHint: "连接中断，正在续传",
  done: "传输完成",
  doneNote: "校验通过。关闭页面即离开，服务器没有留下任何副本。",
  save: "保存文件",
  verifyFailed: "校验没通过，文件可能损坏。已停止保存，请让对方重发一次。",
  hashOk: "SHA-256 校验通过",
  hostOffline: "管理员已离线，等待重连",
  roomClosed: "房间已结束，服务器没有留下任何副本。",
  tooLarge: "超过对方浏览器能接收的上限。换成电脑接收，或让对方安装 App。",
  iosWarning:
    "这台 iPhone 接收大文件风险较高。浏览器最多稳定保存约 100 MB。建议改用电脑接收，或安装 CrossFile App。",
  relaySlow: "正在通过中继服务器传输，速度会慢一些。",
  errorGeneric: "出错了，请重试",
  selectFileFirst: "先选择一个文件",
  acceptFiles: "接收文件",
  accept: "接收",
  decline: "拒绝接收",
  fromDevice: "来自对方的文件",
  totalSize: "共",
  secure: "端到端加密",
  pathLan: "局域网直连",
  pathDirect: "直连",
  pathRelay: "中继",
  qrAlt: "房间二维码，包含密钥",
  reconnecting: "连接中断，正在重连…",
  connectionLost: "连接已失效，请重新创建房间",
  submitting: "正在发送…",
  // 任意互传（ADR 0010 / docs/02 v2）：管理员 + 成员、统一 Room 页、显示名
  admin: "管理员",
  member: "成员",
  createRoom: "创建房间",
  joinRoom: "加入房间",
  enterCodeOrLink: "输入 6 位码或粘贴链接",
  sendTo: "发送给",
  selectRecipient: "选择成员",
  incomingTitle: "对方想给你发文件",
  incomingFrom: "来自",
  nameDialogTitle: "这台设备叫什么？",
  nameHint: "其他设备会看到这个名字，可以随时改。",
  nameSave: "保存名称",
  nameForget: "忘记这台设备的名称",
  nameSaved: "名称已保存",
  queued: "已排队，等对方当前传输完成",
  busyRetry: "对方正在传输，稍后自动开始",
  versionOutdated: "页面版本太旧，连不上新协议",
  refreshPage: "刷新页面",
  adminOffline: "管理员已离开，房间即将结束",
  memberOffline: "对方已离线，60 秒内回来可继续",
  inviteOnlyAdmin: "只有管理员能邀请新成员",
  waitingMember: "等待对方加入",
  roomWaitingMembers: "还没有其他成员加入。让对方扫码或输入 6 位码。",
  // 统一 Room 页新文案（design/screens 01–06，ADR 0010）
  enterRoomCode: "输入 6 位房间码",
  pasteInviteLink: "粘贴邀请链接",
  anyToAnyHint: "房间里任何成员都能给你发文件，你也可以发给任何一台设备",
  oneTransferPerPair: "同一对设备一次只传一条，其他成员可以同时传",
  memberCountTemplate: "成员 {n}/{max}",
  rename: "改名",
  adminOnly: "仅管理员可见",
  leaveRoom: "退出",
  confirmEveryReceive: "每次接收都需要你确认",
  // 自动接收开关（docs/02 §11.3，默认关；本地设置）
  autoAccept: "自动接收",
  autoAcceptHint:
    "开启后，房间里任何成员发来的文件都会自动接收，不再逐次确认。只在你信任当前房间时开启。",
  autoAcceptReceiving: "已自动接收来自 {name} 的文件",
  // 管理权移交（docs/02 §11.2）：服务端只广播 members，客户端据 isAdmin 变化提示
  adminPromoted: "原管理员已离线，你现在是房间管理员，可以批准成员、结束房间。",
  adminHandoverNotice: "管理员已离线，管理权已移交给 {name}。",
  rejoinLostTitle: "你的管理员身份已失效",
  rejoinLostBody:
    "你离线期间管理权已移交给其他成员。房间还在，重新加入后需要新管理员批准。",
  rejoinExpiredTitle: "重连凭证已失效",
  rejoinExpiredBody:
    "房间还在，但这次重连凭证已过期。重新加入后需要管理员再次批准。",
  rejoinAsMember: "重新加入房间",
  rejoinHome: "返回首页",
  howThisRoomWorks: "这个房间怎么传",
  roomStillLive: "房间仍在进行 · 你可以回到房间继续给成员发文件",
  // 传输取消 / 重试（docs/02 §10.2 取消注记，v0.4.0）：取消是正常结束，不是错误
  cancelTransfer: "取消",
  cancelQueued: "取消排队",
  cancelQueuedNotice: "已取消排队中的传输",
  cancelledLocal: "已取消这次传输",
  cancelledByPeer: "对方已取消这次传输",
  cancelledLocalHint:
    "已停止发送和接收，本机缓存已清理，对方也会停下并清理半成品。文件没有发出去。",
  cancelledByPeerHint: "对方停止了这次传输，文件没有收完，已清理半成品。",
  retry: "重试",
  retrying: "正在重试…",
  retryHint: "用同一批文件重新发起（对端会再次确认，从头开始传）",
  cannotRetryIncoming: "需要对方重新发送",
  // 入口页 / 房间页区块标题与按钮（web-agent 收尾用）
  actionTitle: "开始传输",
  inviteTitle: "邀请成员",
  transferBusyTitle: "正在互传",
  backToRoom: "回到房间",
  // 房间页 RoomPage：页面内硬编码文案（web-agent 机械替换用，值逐字对齐页面）
  // 带 {n}/{size}/{name}/{limit}/{code} 的为模板 key，替换时用模板字符串拼装。
  statusConnecting: "正在连接…",
  statusBackHome: "返回首页",
  statusMemberRemoved: "已移除",
  statusMemberRejected: "已拒绝",
  statusFilesSelected: "已选 {n} 个文件",
  statusIncomingSummary: "共 {size} · {n} 个文件",
  statusActiveTransfers: "{n} 条进行中",
  statusQueuedSuffix: " · {n} 条排队",
  statusSendSummary: "发给 {n} 台设备 · 共 {size} · 按成员逐个发送",
  statusSavedTo: "已保存到",
  statusSasWaitingPeer: "已确认，等待对方确认…",
  statusSasLabel: "安全码图标",
  statusRoomCodeLabel: "6 位房间码 {code}",
  metaSelf: "我",
  metaSelfWithSep: "我 · ",
  metaPeer: "对方",
  metaDeviceIphone: "iPhone",
  metaDevicePhone: "手机",
  metaDeviceMacbook: "MacBook",
  metaDeviceWindows: "Windows",
  metaDeviceComputer: "电脑",
  metaSasCodeHint: "6 位码加入",
  metaInviteOtherDevice: "其他设备也可以打开",
  metaEnterRoomCode: "输入房间码",
  metaRoomFooter: "房间里的设备需保持页面打开 · 服务器不保存任何内容 ·",
  metaLabelTransfer: "传输",
  metaLabelEncryption: "加密",
  metaLabelIntegrity: "完整性",
  metaLabelServer: "服务器",
  metaEncryptionValue: "AES-256-GCM · 每个传输独立密钥",
  metaIntegrityValue: "逐片认证 · 完成后校验 SHA-256",
  metaServerValue: "只转发密文，不落盘",
  metaFileListMore: "{name} 等 {n} 个文件",
  dialogCancel: "取消",
  dialogEndRoomTitle: "结束房间？",
  dialogEndRoomBody:
    "正在传输的文件会中断，房间和密钥会立即销毁，服务器不会留下任何副本。",
  dialogSendWarnTitle: "对方设备可能保存失败",
  dialogSendWarnConfirm: "仍要发送",
  dialogSendWarnBody:
    "{size} 超过对方设备稳定保存上限（约 {limit} MB）。 可以继续发送，但对方可能在保存时失败；建议改用电脑接收或让对方安装 App。",
  dialogRemoveTitle: "移除成员？",
  dialogRemoveBody: "对方会立即断开，需要重新扫码或输入房间码才能再加入。",
  dialogNameLabel: "显示名",
  dialogSasTitle: "核对安全码",
  dialogSasBody:
    "对方用 6 位码加入，密钥还没有送过去。和对方核对下面 4 个图标，一致后再通过加密通道传密钥。",
  dialogSasConfirm: "四个图标一致",
  dialogRiskTitle: "仍要接收这个大文件？",
  dialogRiskConfirm: "仍要接收",
  dialogRiskBody: "这台设备保存大文件有风险，可能无法保存。",
  dialogRiskHint: "也可以让对方改用电脑接收，或安装 CrossFile App。",
  errorRejectedTitle: "对方可能收不了这个文件",
  errorRejectedBody:
    "{size} 超过 {name} 能接收的上限（约 {limit} MB）。换成电脑接收，或让对方安装 CrossFile App。",
  errorOutgoingRiskTitle: "这台设备存下大文件有风险",
  errorSoftLimitBody:
    "{size} 超过 {name} 的稳定保存上限（约 {limit} MB）。可以继续发送，但对方可能保存失败；建议改用电脑接收或安装 App。",
  errorIncomingRiskTitle: "这台设备保存大文件有风险",
  errorVersionOutdatedDetail: "服务器使用新的协议版本，请刷新页面后重新加入。",
} as const;

export type CopyKey = keyof typeof copy;

/**
 * Protocol error codes (docs/02 §3.6) translated into user-facing copy that always
 * says what to do next (docs/04 §15: 不夸张、给下一步).
 */
const ERROR_COPY: Record<string, string> = {
  ROOM_NOT_FOUND: "房间不存在或已过期。请重新扫码，或让对方重新建一个房间。",
  ROOM_CLOSED: "房间已结束。请让对方重新建一个房间，再扫码加入。",
  ROOM_FULL: "房间的成员已经满了。请让管理员移除一个成员，或稍后再试。",
  PROOF_INVALID:
    "这次加入的凭证无效，可能有人在冒充。已拒绝，请重新扫描对方的二维码。",
  SAS_MISMATCH: "安全码不一致，连接可能被中间人劫持。已中止传输，请重新建房。",
  TOO_LARGE:
    "这个文件超过对方设备能接收的上限。请让对方改用电脑接收，或安装 App。",
  CAPABILITY_RISK_DECLINED:
    "对方设备无法可靠保存这么大的文件，对方成员拒绝了这次传输。请改用电脑接收，或让对方安装 App。",
  HASH_MISMATCH: "校验没通过，文件可能损坏。已停止保存，请让对方重发一次。",
  TIMEOUT: "连接超时。请检查网络后重试，或让对方重新加入。",
  PEER_GONE: "对方已经断开了。请重新扫码加入，或让对方重新发一次。",
  RATE_LIMITED: "操作太频繁了，请稍等一会儿再试。",
  BAD_MESSAGE: "通信协议出错。请刷新页面重试；如果一直失败，请报告这个问题。",
  VERSION_MISMATCH: "页面版本和服务器不一致。刷新页面后再试一次。",
  NOT_ADMIN: "这个操作只有管理员能做。",
  BUSY: "对方正在传输，稍后自动开始。",
};

export function errorText(code: string | undefined, fallback?: string): string {
  if (!code) return fallback ?? copy.errorGeneric;
  return ERROR_COPY[code] ?? fallback ?? copy.errorGeneric;
}

export function pathLabel(path: "lan" | "direct" | "relay"): string {
  return path === "lan"
    ? copy.pathLan
    : path === "direct"
      ? copy.pathDirect
      : copy.pathRelay;
}

/** 成员计数文案，例如 `成员 2/4`（模板见 {@link copy.memberCountTemplate}）。 */
export function memberCountText(current: number, max: number): string {
  return copy.memberCountTemplate
    .replace("{n}", String(current))
    .replace("{max}", String(max));
}
