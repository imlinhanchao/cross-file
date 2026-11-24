import { copy } from "@crossfile/ui";
import { Icon } from "../ui/Icon.js";

/** Privacy statement (docs/01 §5 — wording is fixed; changing it needs review). */
export function PrivacyPage() {
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="send" />
          </span>
          {copy.brand}
        </a>
        <span className="topbar__spacer" />
        <a className="btn btn--ghost btn--sm" href="/">
          回到首页
        </a>
      </header>

      <main className="shell">
        <article className="stack gap-4" style={{ maxWidth: 720, margin: "32px auto 0" }}>
          <p className="eyebrow">隐私说明</p>
          <h1 className="h1">服务器不存一个字节</h1>
          <p className="lead">
            文件在你的设备和对方的设备之间端到端加密传输，服务器只转发密文，密钥只存在于二维码或链接里，从不发送到服务器。
          </p>
          <p className="lead">没有账号，没有历史，没有分析埋点，没有持久日志。会话一结束，服务器内存里的房间状态立即清除。</p>
          <div className="signal-rule" aria-hidden="true" />
          <h2 className="h2">服务器能看到什么</h2>
          <p className="lead">
            为了建立连接，服务器能看到双方的 IP 地址、房间存在的时间、以及经过中继的流量大小。这是我们诚实说明的部分；自托管可以自己验证这一点。
          </p>
          <h2 className="h2">自己验证</h2>
          <p className="lead">
            仓库里的 <span className="mono">tests/audit/zero-storage.sh</span> 用 strace 与只读容器核查服务器不写盘、不落数据库、只输出一行启动日志。
          </p>
          <p className="note">
            <Icon name="shield-check" size="sm" />
            <span>本页与 README、自托管文档使用同一套措辞，改字需要过审。</span>
          </p>
        </article>
      </main>
    </div>
  );
}
