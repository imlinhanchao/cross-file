import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { judgeFile } from "@crossfile/core";
import { copy, formatBytes, pathLabel, splitCode } from "@crossfile/ui";
import { HostController } from "../lib/host.js";
import { useApp } from "../store.js";
import { Icon } from "../ui/Icon.js";
import { Dialog } from "../ui/Dialog.js";
import { PathBadge, Progress, WarningCard } from "../ui/bits.js";

function guestLabel(caps: { platform: string; screen: string; uaFamily: string }): string {
  if (caps.screen === "phone") return caps.platform === "ios" ? "iPhone" : "手机";
  return caps.uaFamily === "safari" ? "Safari" : caps.platform === "linux" ? "电脑" : "设备";
}

export function HostPage() {
  const state = useApp();
  const controller = useRef<HostController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [qrSvg, setQrSvg] = useState("");
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"end-room" | "send-warn" | "remove-guest" | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  useEffect(() => {
    const instance = new HostController();
    controller.current = instance;
    (globalThis as { __cfHost?: HostController }).__cfHost = instance;
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
  const assignedBytes = state.files.reduce(
    (sum, file) => sum + file.size * (state.assignments[file.id]?.length ?? 0),
    0,
  );
  const verdicts = joined.map((guest) => ({ guest, verdict: judgeFile(totalBytes, guest.caps) }));
  const rejected = verdicts.find((entry) => entry.verdict.level === "reject");
  const warned = verdicts.find((entry) => entry.verdict.level === "warn");
  const canSend =
    joined.length > 0 &&
    state.files.length > 0 &&
    !rejected &&
    (state.phase === "joined" || state.phase === "approval");

  const pickFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    controller.current?.setFiles(Array.from(files));
  };

  const startSend = (): void => {
    if (!canSend) return;
    if (warned) {
      setDialog("send-warn");
      return;
    }
    void controller.current?.sendNow().catch((error: unknown) => useApp.getState().patch({ error: String(error) }));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A dialog that already handled Escape (and closed itself) must win.
      if (event.defaultPrevented) return;
      if (dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setDialog("end-room");
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        startSend();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog, canSend, warned]);

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
        <button className="btn btn--ghost" type="button" onClick={() => setDialog("end-room")}>
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
                      <span className="row gap-1 wrap" aria-label="发送给">
                        {joined.map((guest) => {
                          const checked = (state.assignments[file.id] ?? []).includes(guest.id);
                          return (
                            <button
                              key={guest.id}
                              type="button"
                              className="chip-toggle"
                              data-checked={checked}
                              data-testid={`assign-${file.id}-${guest.id}`}
                              onClick={() => {
                                useApp.getState().toggleAssignment(file.id, guest.id);
                                controller.current?.refreshManifests();
                              }}
                            >
                              {checked ? <Icon name="check" size="sm" /> : null}
                              {guestLabel(guest.caps)}
                            </button>
                          );
                        })}
                        <span className="small muted">{assignedBytes > 0 ? "" : "未选择接收方"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="note mt-4">
                  <Icon name="lock" size="sm" />
                  <span>{copy.privacyNote}</span>
                </p>
              </div>
            ) : null}

            {state.files.length > 0 && rejected ? (
              <WarningCard
                title="对方可能收不了这个文件"
                body={`${formatBytes(totalBytes)} 超过对方浏览器能接收的上限（约 ${rejected.verdict.hardLimitMB} MB）。换成电脑接收，或让对方安装 CrossFile App。`}
              />
            ) : null}
            {state.files.length > 0 && !rejected && warned ? (
              <WarningCard
                title="这台设备存下大文件有风险"
                body={`${formatBytes(totalBytes)} 超过稳定保存上限（约 ${warned.verdict.softLimitMB} MB，${warned.guest.caps.platform === "ios" ? "iPhone" : warned.guest.caps.uaFamily}）。可以继续发送，但对方可能保存失败；建议改用电脑接收或安装 App。`}
              />
            ) : null}

            {state.sasPending && state.sas ? (
              <div className="card">
                <div className="card__head">
                  <span className="card__title">核对安全码</span>
                  <span className="spacer" />
                  <span className="card__hint">6 位码加入</span>
                </div>
                <p className="small muted">
                  对方用 6 位码加入，密钥还没有送过去。先和对方核对下面 4 个图标，一致后再通过加密通道传密钥。
                </p>
                <div className="row gap-4 mt-4" style={{ fontSize: 40, lineHeight: 1.2 }} aria-label="安全码图标">
                  {state.sas.map((emoji, index) => (
                    <span key={index}>{emoji}</span>
                  ))}
                </div>
                {state.sasConfirmedByMe ? (
                  <p className="note mt-4">
                    <Icon name="clock" size="sm" />
                    <span>已确认，等待对方确认…</span>
                  </p>
                ) : (
                  <button
                    className="btn btn--primary btn--lg btn--block mt-4"
                    type="button"
                    data-testid="sas-confirm-host"
                    onClick={() => controller.current?.confirmSas()}
                  >
                    <Icon name="check" size="sm" />
                    四个图标一致
                  </button>
                )}
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
              对方需保持页面打开 · 服务器不保存任何内容 · <a href="/privacy">隐私说明</a>
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

              <div className="qr-frame" role="img" aria-label={copy.qrAlt}>
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
              <p className="note">
                <Icon name="link" size="sm" />
                <span>
                  接收方也可以打开 <span className="mono">{location.origin}/code</span> 输入房间码
                </span>
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
                      {guest.status === "joined" ? (
                        <button
                          className="icon-btn"
                          type="button"
                          aria-label={`移除 ${guestLabel(guest.caps)}`}
                          data-testid={`remove-${guest.id}`}
                          onClick={() => {
                            setRemoveTarget(guest.id);
                            setDialog("remove-guest");
                          }}
                        >
                          <Icon name="x" size="sm" />
                        </button>
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
          {joined.length > 0
            ? `发给 ${joined.length} 个接收方 · 共 ${formatBytes(assignedBytes || totalBytes)} · 逐个发送`
            : copy.emptyReceivers}
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
          onClick={() => startSend()}
        >
          <Icon name="arrow-right" size="sm" />
          {state.phase === "transferring" ? copy.transferInProgress : copy.startSend}
        </button>
      </div>

      <Dialog
        open={dialog === "end-room"}
        title="结束房间？"
        confirmLabel="结束房间"
        danger
        onConfirm={() => {
          setDialog(null);
          controller.current?.close();
        }}
        onCancel={() => setDialog(null)}
      >
        正在传输的文件会中断，房间和密钥会立即销毁，服务器不会留下任何副本。
      </Dialog>

      <Dialog
        open={dialog === "send-warn"}
        title="对方设备可能保存失败"
        confirmLabel="仍要发送"
        onConfirm={() => {
          setDialog(null);
          void controller.current?.sendNow().catch((error: unknown) => useApp.getState().patch({ error: String(error) }));
        }}
        onCancel={() => setDialog(null)}
      >
        {formatBytes(totalBytes)} 超过对方设备稳定保存上限（约 {warned?.verdict.softLimitMB ?? 150} MB）。
        可以继续发送，但对方可能在保存时失败；建议改用电脑接收或让对方安装 App。
      </Dialog>

      <Dialog
        open={dialog === "remove-guest"}
        title="移除接收方？"
        confirmLabel="移除"
        danger
        onConfirm={() => {
          if (removeTarget) controller.current?.remove(removeTarget);
          setDialog(null);
          setRemoveTarget(null);
        }}
        onCancel={() => {
          setDialog(null);
          setRemoveTarget(null);
        }}
      >
        对方会立即断开，需要重新扫码或输入房间码才能再加入。
      </Dialog>

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
      {pending.length > 0 ? <span className="sr-only" role="status">{copy.approveHint}</span> : null}
    </div>
  );
}
