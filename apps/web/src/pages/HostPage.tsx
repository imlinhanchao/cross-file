import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { copy, formatBytes, pathLabel, splitCode } from "@crossfile/ui";
import { HostController } from "../lib/host.js";
import { useApp } from "../store.js";
import { Icon } from "../ui/Icon.js";
import { PathBadge, Progress, WarningCard } from "../ui/bits.js";

export function HostPage() {
  const state = useApp();
  const controller = useRef<HostController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [qrSvg, setQrSvg] = useState("");
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const instance = new HostController();
    controller.current = instance;
    void instance.start().catch((error: unknown) => {
      useApp.getState().patch({ phase: "error", error: String(error) });
    });
    return () => instance.close();
  }, []);

  useEffect(() => {
    if (!state.link) return;
    void QRCode.toString(state.link, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then((svg) => {
      setQrSvg(svg.replace("<svg", '<svg class="qr-svg"').replace(/\s(?:width|height)="[^"]*"/g, ""));
    });
  }, [state.link]);

  const guests = state.guests;
  const pending = guests.filter((guest) => guest.status === "pending");
  const joined = guests.filter((guest) => guest.status === "joined" || guest.status === "transferring" || guest.status === "done");
  const totalBytes = state.files.reduce((sum, file) => sum + file.size, 0);
  const canSend = joined.length > 0 && state.files.length > 0 && (state.phase === "joined" || state.phase === "approval");

  const pickFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    controller.current?.setFiles(Array.from(files));
  };

  const copyLink = async (): Promise<void> => {
    if (!state.link) return;
    try {
      await navigator.clipboard.writeText(state.link);
      setToast(copy.copied);
      setTimeout(() => setToast(null), 2000);
    } catch {
      setToast(state.link);
    }
  };

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
        <button className="icon-btn" type="button" aria-label={copy.copyLink} onClick={() => void copyLink()}>
          <Icon name="link" />
        </button>
        <button className="btn btn--ghost" type="button" onClick={() => controller.current?.close()}>
          {copy.endRoom}
        </button>
      </header>

      <main className="shell">
        <div className="room-grid">
          <section className="stack gap-5" aria-labelledby="room-title">
            <div className="stack gap-2">
              <p className="eyebrow">
                {state.phase === "waiting" ? "房间已创建 · 等待接收方" : state.phase === "approval" ? "有人请求加入" : "房间进行中"}
              </p>
              <h1 id="room-title" className="display">{copy.roomTitle}</h1>
              <p className="lead">{copy.roomLead}</p>
            </div>

            {state.error ? <WarningCard title={copy.errorGeneric} body={state.error} /> : null}

            <div
              className={dragging ? "dropzone dropzone--active" : "dropzone"}
              role="button"
              tabIndex={0}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") fileInput.current?.click();
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                pickFiles(event.dataTransfer.files);
              }}
            >
              <span className="dropzone__icon"><Icon name="upload" size="lg" /></span>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{copy.dropzone}</span>
              <span className="small muted">{copy.dropzoneHint}</span>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="file-input"
              onChange={(event) => pickFiles(event.target.files)}
            />

            {state.files.length > 0 ? (
              <div className="card">
                <div className="card__head">
                  <span className="card__title">已选 {state.files.length} 个文件</span>
                  <span className="card__hint">共 {formatBytes(totalBytes)}</span>
                  <span className="spacer" />
                  <button
                    className="btn btn--ghost btn--sm"
                    type="button"
                    onClick={() => controller.current?.setFiles([])}
                  >
                    {copy.clear}
                  </button>
                </div>
                <ul className="file-list">
                  {state.files.map((file) => (
                    <li className="file-row" key={file.id}>
                      <span className="file-tile"><Icon name={file.mime.startsWith("video/") ? "file-video" : "file"} /></span>
                      <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <span className="file-name">{file.name}</span>
                        <span className="file-meta">{formatBytes(file.size)}</span>
                      </span>
                      <span className="spacer" />
                      <span className="small muted">{state.phase === "transferring" ? "传输中" : "待发送"}</span>
                    </li>
                  ))}
                </ul>
                <p className="note mt-4">
                  <Icon name="lock" size="sm" />
                  <span>{copy.privacyNote}</span>
                </p>
              </div>
            ) : null}

            {state.transfer && state.transfer.totalBytes > 0 ? (
              <div className="card">
                <Progress
                  sentBytes={state.transfer.sentBytes}
                  totalBytes={state.transfer.totalBytes}
                  speedBps={state.transfer.speedBps}
                  path={state.transfer.path}
                />
              </div>
            ) : null}

            {state.phase === "done" ? (
              <div className="warn-card" style={{ background: "var(--primary-soft)", borderColor: "var(--primary)" }}>
                <Icon name="circle-check" />
                <div>
                  <div className="warn-card__title">{copy.done}</div>
                  <div className="warn-card__body">{copy.doneNote}</div>
                </div>
              </div>
            ) : null}

            <div className="signal-rule" aria-hidden="true" />
            <p className="small muted">
              对方需保持页面打开 · 服务器不保存任何内容
            </p>
          </section>

          <aside className="stack gap-4">
            <section className="card qr-card" aria-labelledby="qr-title">
              <div className="card__head" style={{ marginBottom: 0 }}>
                <span className="card__title" id="qr-title">{copy.joinCardTitle}</span>
                <span className="spacer" />
                <span className="pill">
                  <Icon name="wifi" size="sm" />
                  <span>{copy.lanFirst}</span>
                </span>
              </div>

              <div className="qr-frame" aria-label={copy.qrAlt}>
                {qrSvg ? <div dangerouslySetInnerHTML={{ __html: qrSvg }} /> : null}
              </div>

              <div className="join-line">
                <Icon name="link" size="sm" />
                <span className="url">{state.link ?? "…"}</span>
                <span className="spacer" />
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={copy.copyLink}
                  style={{ width: 36, height: 36 }}
                  onClick={() => void copyLink()}
                >
                  <Icon name="copy" size="sm" />
                </button>
              </div>

              <div className="code-block">
                <span className="code-digits" aria-label={`6 位房间码 ${state.code ?? ""}`}>
                  {state.code ? splitCode(state.code) : "··· ···"}
                </span>
                <span className="code-label">
                  <span className="eyebrow">{copy.orEnterCode}</span>
                  <span className="small muted">{copy.codeValidity}</span>
                </span>
              </div>

              <p className="note">
                <Icon name="shield-check" size="sm" />
                <span>{copy.privacyShort}</span>
              </p>
            </section>

            <section className="card" aria-labelledby="recv-title">
              <div className="card__head">
                <span className="card__title" id="recv-title">
                  接收方 {joined.length + pending.length}/4
                </span>
                <span className="spacer" />
                <span className="card__hint">{copy.joinCardHint}</span>
              </div>

              {guests.length === 0 ? (
                <p className="small muted">{copy.emptyReceivers}</p>
              ) : (
                <ul className="receiver-list">
                  {guests.map((guest) => (
                    <li
                      className={guest.status === "pending" ? "receiver receiver--pending" : "receiver"}
                      key={guest.id}
                      data-testid={`guest-${guest.id}`}
                    >
                      <span className="receiver__tile">
                        <Icon name={guest.caps.screen === "phone" ? "smartphone" : "laptop"} />
                      </span>
                      <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                        <span className="receiver__name">
                          {guest.caps.platform === "ios" ? "iPhone" : guest.caps.screen === "phone" ? "手机" : "电脑"}
                          {" · "}
                          {guest.caps.uaFamily}
                        </span>
                        <span className="receiver__meta">
                          {guest.status === "pending"
                            ? copy.pendingApproval
                            : guest.status === "removed"
                              ? "已移除"
                              : guest.status === "done"
                                ? copy.done
                                : guest.status === "transferring"
                                  ? copy.transferInProgress
                                  : "已加入 · 等待发送"}
                        </span>
                      </span>
                      <span className="spacer" />
                      {guest.status === "pending" ? (
                        <span className="receiver__actions">
                          <button
                            className="btn btn--primary btn--sm"
                            type="button"
                            data-testid="approve"
                            onClick={() => controller.current?.approve(guest.id)}
                          >
                            {copy.approve}
                          </button>
                          <button
                            className="btn btn--ghost btn--sm"
                            type="button"
                            onClick={() => controller.current?.deny(guest.id)}
                          >
                            {copy.deny}
                          </button>
                        </span>
                      ) : guest.path ? (
                        <PathBadge path={guest.path} />
                      ) : null}
                      {guest.progress && guest.progress.totalBytes > 0 ? (
                        <Progress
                          compact
                          sentBytes={guest.progress.sentBytes}
                          totalBytes={guest.progress.totalBytes}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </main>

      <div className="sticky-bar">
        <span className="small secondary">
          {joined.length > 0 ? `发给 ${joined.length} 个接收方 · 共 ${formatBytes(totalBytes)}` : copy.emptyReceivers}
        </span>
        <span className="spacer" />
        <button className="btn btn--secondary" type="button" onClick={() => fileInput.current?.click()}>
          <Icon name="plus" size="sm" />
          {copy.addFile}
        </button>
        <button
          className="btn btn--primary btn--lg"
          type="button"
          data-testid="start-send"
          disabled={!canSend}
          onClick={() => void controller.current?.sendNow().catch((error: unknown) => useApp.getState().patch({ error: String(error) }))}
        >
          <Icon name="arrow-right" size="sm" />
          {state.phase === "transferring" ? copy.transferInProgress : copy.startSend}
        </button>
      </div>

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
      {pending.length > 0 ? <span className="sr-only" role="status">{copy.approveHint}</span> : null}
    </div>
  );
}
