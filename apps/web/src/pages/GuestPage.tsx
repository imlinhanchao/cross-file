import { useEffect, useRef } from "react";
import { copy, formatBytes, mimeLabel } from "@crossfile/ui";
import { GuestController } from "../lib/guest.js";
import { useApp } from "../store.js";
import { Icon } from "../ui/Icon.js";
import { Progress, WarningCard } from "../ui/bits.js";

export function GuestPage({ code }: { code?: string }) {
  const state = useApp();
  const controller = useRef<GuestController | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const instance = new GuestController(code);
    controller.current = instance;
    void instance.start().catch((error: unknown) => {
      useApp.getState().patch({ phase: "error", error: String(error) });
    });
    return () => instance.close();
  }, [code]);

  const totalBytes = state.files.reduce((sum, file) => sum + file.size, 0);
  const canAccept = state.phase === "joined" && state.files.length > 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="send" />
          </span>
          {copy.brand}
        </span>
        <span className="pill pill--secure">
          <Icon name="shield-check" size="sm" />
          <span>{copy.secure}</span>
        </span>
        <span className="topbar__spacer" />
      </header>

      <main className="shell">
        <div className="stack gap-4" style={{ maxWidth: 640, margin: "24px auto 0" }}>
          {state.phase === "provisioning" ? (
            <div className="card">
              <p className="lead">正在连接对方…</p>
              <p className="small muted">密钥只存在于这个链接里，不会发给服务器。</p>
            </div>
          ) : null}

          {state.sasPending && state.sas ? (
            <div className="card">
              <div className="card__head">
                <span className="card__title">核对安全码</span>
                <span className="spacer" />
                <span className="card__hint">6 位码加入</span>
              </div>
              <p className="lead">和对方屏幕上的 4 个图标一致吗？</p>
              <div className="row gap-4" style={{ fontSize: 44, lineHeight: 1.2 }} aria-label="安全码图标">
                {state.sas.map((emoji, index) => (
                  <span key={index}>{emoji}</span>
                ))}
              </div>
              <p className="small muted mt-4">
                这个码来自双方的加密握手，服务器无法伪造。不一致请点拒绝并让对方重新建房。
              </p>
              {state.sasConfirmedByMe ? (
                <p className="note mt-4">
                  <Icon name="clock" size="sm" />
                  <span>已确认，等待对方确认…</span>
                </p>
              ) : (
                <button
                  className="btn btn--primary btn--lg btn--block mt-4"
                  type="button"
                  data-testid="sas-confirm"
                  onClick={() => controller.current?.confirmSas()}
                >
                  <Icon name="check" size="sm" />
                  四个图标一致
                </button>
              )}
            </div>
          ) : null}

          {state.phase === "waiting" ? (
            <div className="card">
              <div className="card__head">
                <span className="card__title">{copy.waitingHost}</span>
                <span className="spacer" />
                <span className="dot-live" aria-hidden="true" />
              </div>
              <p className="lead">{copy.waitApproval}</p>
              <p className="small muted">对方需要在他的界面上点「批准」。</p>
            </div>
          ) : null}

          {state.files.length > 0 && state.phase !== "done" ? (
            <div className="card">
              <div className="card__head">
                <span className="card__title">{copy.fromDevice}</span>
                <span className="spacer" />
                <span className="card__hint">
                  {state.files.length} 个文件 · 共 {formatBytes(totalBytes)}
                </span>
              </div>
              <ul className="file-list">
                {state.files.map((file) => (
                  <li className="file-row" key={file.id}>
                    <span className="file-tile">
                      <Icon name={file.mime.startsWith("video/") ? "file-video" : "file-text"} />
                    </span>
                    <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                      <span className="file-name">{file.name}</span>
                      <span className="file-meta">
                        {formatBytes(file.size)} · {mimeLabel(file)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {state.risk?.level === "warn" ? (
                <div className="mt-4">
                  <WarningCard title="这台设备保存大文件有风险" body={state.risk.message} />
                </div>
              ) : null}
              {canAccept ? (
                <div className="row gap-3 mt-4">
                  <button
                    className="btn btn--primary btn--lg btn--block"
                    type="button"
                    data-testid="accept"
                    onClick={() => controller.current?.accept()}
                  >
                    <Icon name="arrow-right" size="sm" />
                    {state.risk?.level === "warn" ? "仍要接收" : copy.accept}
                  </button>
                </div>
              ) : null}
              <p className="note mt-4">
                <Icon name="lock" size="sm" />
                <span>{copy.privacyNote}</span>
              </p>
            </div>
          ) : null}

          {state.transfer && state.phase === "transferring" ? (
            <div className="card">
              <Progress
                sentBytes={state.transfer.sentBytes}
                totalBytes={state.transfer.totalBytes}
                speedBps={state.transfer.speedBps}
                path={state.transfer.path}
              />
              <p className="small muted mt-4">请保持页面在前台，锁屏或切后台可能导致中断。</p>
            </div>
          ) : null}

          {state.phase === "done" && state.result?.ok ? (
            <div className="card">
              <div className="card__head">
                <span className="complete-mark" aria-hidden="true">
                  <Icon name="check" />
                </span>
                <span className="card__title">{copy.done}</span>
              </div>
              <p className="lead">{state.result.fileName}</p>
              <p className="small muted">
                {formatBytes(state.result.bytes ?? 0)} · {copy.hashOk}
              </p>
              <p className="code-block small mono" style={{ wordBreak: "break-all", marginTop: 8 }}>
                {state.result.sha256}
              </p>
              {state.result.path ? (
                <p className="small muted mt-4">
                  已保存到 <span className="mono">{state.result.path}</span>
                </p>
              ) : null}
              {state.result.url ? (
                <a
                  className="btn btn--primary btn--lg btn--block mt-4"
                  href={state.result.url}
                  download={state.result.fileName}
                  data-testid="save"
                >
                  <Icon name="upload" size="sm" />
                  {copy.save}
                </a>
              ) : null}
              <p className="note mt-4">
                <Icon name="shield-check" size="sm" />
                <span>{copy.doneNote}</span>
              </p>
            </div>
          ) : null}

          {state.error ? <WarningCard title={copy.errorGeneric} body={state.error} /> : null}
        </div>
      </main>
    </div>
  );
}
