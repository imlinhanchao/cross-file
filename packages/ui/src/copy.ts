/** All user-visible copy (docs/04 §15). i18n hook point: one file, keyed strings. */
export const copy = {
  brand: "CrossFile",
  tagline: "扫码即传 · 端到端加密 · 服务器不存一个字节",
  privacyShort: "服务器不存一个字节。密钥只在这张码里。",
  privacyNote: "文件不经过服务器存储，房间结束后不留下任何副本",
  roomTitle: "把文件发给谁？",
  roomLead: "对方扫码或打开链接即可接收，无需安装任何东西。文件直接在你的设备和对方设备之间传输。",
  dropzone: "拖入文件，或点击选择",
  dropzoneHint: "单个文件 ≤ 500 MB · 单次总计 ≤ 2 GB",
  emptyReceivers: "还没有设备加入。让对方扫码，或把 6 位码发给他。",
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
  waitingHost: "等待发送方",
  waitApproval: "等待对方批准…",
  approveHint: "对方已请求加入，确认后开始传输",
  transferInProgress: "正在传输",
  resumeHint: "连接中断，正在续传",
  done: "传输完成",
  doneNote: "校验通过。关闭页面即离开，服务器没有留下任何副本。",
  save: "保存文件",
  verifyFailed: "校验没通过，文件可能损坏。已停止保存，请让对方重发一次。",
  hashOk: "SHA-256 校验通过",
  hostOffline: "对方的房间已关闭",
  roomClosed: "房间已结束，服务器没有留下任何副本。",
  tooLarge: "超过对方浏览器能接收的上限。换成电脑接收，或让对方安装 App。",
  iosWarning: "这台 iPhone 接收大文件风险较高。浏览器最多稳定保存约 100 MB。建议改用电脑接收，或安装 CrossFile App。",
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
} as const;

export type CopyKey = keyof typeof copy;

/**
 * Protocol error codes (docs/02 §3.6) translated into user-facing copy that always
 * says what to do next (docs/04 §15: 不夸张、给下一步).
 */
const ERROR_COPY: Record<string, string> = {
  ROOM_NOT_FOUND: "房间不存在或已过期。请重新扫码，或让对方重新建一个房间。",
  ROOM_CLOSED: "房间已结束。请让对方重新建一个房间，再扫码加入。",
  ROOM_FULL: "房间的接收方已经满了。请让对方移除一个接收方，或稍后再试。",
  PROOF_INVALID: "这次加入的凭证无效，可能有人在冒充。已拒绝，请重新扫描对方的二维码。",
  SAS_MISMATCH: "安全码不一致，连接可能被中间人劫持。已中止传输，请重新建房。",
  TOO_LARGE: "这个文件超过对方设备能接收的上限。请让对方改用电脑接收，或安装 App。",
  CAPABILITY_RISK_DECLINED: "对方设备无法可靠保存这么大的文件，接收方拒绝了这次传输。请改用电脑接收，或让对方安装 App。",
  HASH_MISMATCH: "校验没通过，文件可能损坏。已停止保存，请让对方重发一次。",
  TIMEOUT: "连接超时。请检查网络后重试，或让对方重新加入。",
  PEER_GONE: "对方已经断开了。请重新扫码加入，或让对方重新发一次。",
  RATE_LIMITED: "操作太频繁了，请稍等一会儿再试。",
  BAD_MESSAGE: "通信协议出错。请刷新页面重试；如果一直失败，请报告这个问题。",
};

export function errorText(code: string | undefined, fallback?: string): string {
  if (!code) return fallback ?? copy.errorGeneric;
  return ERROR_COPY[code] ?? fallback ?? copy.errorGeneric;
}

export function pathLabel(path: "lan" | "direct" | "relay"): string {
  return path === "lan" ? copy.pathLan : path === "direct" ? copy.pathDirect : copy.pathRelay;
}
