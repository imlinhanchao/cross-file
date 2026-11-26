import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { MAX_MEMBERS, judgeFile } from "@crossfile/core";
import { copy, formatBytes, memberCountText, splitCode } from "@crossfile/ui";
import { RoomController, type RoomMode } from "../lib/room.js";
import { useApp } from "../store.js";
import { Icon } from "../ui/Icon.js";
import { Dialog } from "../ui/Dialog.js";
import { PathBadge, Progress, WarningCard } from "../ui/bits.js";

/** Fill a `{name}` template from copy.ts; the text itself lives in copy.ts. */
function tpl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    String(vars[key] ?? ""),
  );
}

function memberLabel(caps: { platform: string; screen: string }): string {
  if (caps.screen === "phone")
    return caps.platform === "ios"
      ? copy.metaDeviceIphone
      : copy.metaDevicePhone;
  return caps.platform === "mac"
    ? copy.metaDeviceMacbook
    : caps.platform === "win"
      ? copy.metaDeviceWindows
      : copy.metaDeviceComputer;
}

function stateText(member: { state: string; isAdmin: boolean }): string {
  switch (member.state) {
    case "pending":
      return copy.pendingApproval;
    case "transferring":
      return copy.transferInProgress;
    case "done":
      return copy.done;
    case "removed":
      return copy.statusMemberRemoved;
    case "rejected":
      return copy.statusMemberRejected;
    case "offline":
      return member.isAdmin ? copy.adminOffline : copy.memberOffline;
    default:
      return member.isAdmin ? copy.admin : copy.member;
  }
}

export function RoomPage({ mode }: { mode: RoomMode }) {
  const state = useApp();
  const controller = useRef<RoomController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [qrSvg, setQrSvg] = useState("");
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "end-room" | "send-warn" | "remove" | "name" | null
  >(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [riskDialog, setRiskDialog] = useState(false);
  /** DEV-ONLY: ?autosave=1 clicks the save link after completion (AC4 disk check). */
  const autoSaveRef = useRef(false);

  useEffect(() => {
    const instance = new RoomController(mode);
    controller.current = instance;
    const globals = globalThis as {
      __cfRoom?: RoomController;
      __cfHost?: RoomController;
    };
    globals.__cfRoom = instance;
    // v1 debug alias: AC12 and the shell harnesses call `__cfHost.forceDrop()`.
    globals.__cfHost = instance;
    void instance.start().catch((error: unknown) => {
      useApp.getState().patch({ phase: "error", error: String(error) });
    });
    return () => instance.close();
    // The mode is fixed for the lifetime of the page (route-derived).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state.link || state.role !== "admin") return;
    void QRCode.toString(state.link, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
    }).then((svg) => {
      setQrSvg(
        svg
          .replace("<svg", '<svg class="qr-svg"')
          .replace(/\s(?:width|height)="[^"]*"/g, ""),
      );
    });
  }, [state.link, state.role]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (new URLSearchParams(location.search).get("autosave") !== "1") return;
    if (state.phase !== "done" || !state.result?.url || autoSaveRef.current)
      return;
    autoSaveRef.current = true;
    const anchor = document.querySelector<HTMLAnchorElement>(
      '[data-testid="save"]',
    );
    anchor?.click();
  }, [state.phase, state.result?.url]);

  const others = state.members.filter((member) => member.id !== state.selfId);
  const pending = others.filter((member) => member.state === "pending");
  const joined = others.filter(
    (member) =>
      member.state === "joined" ||
      member.state === "transferring" ||
      member.state === "done",
  );
  const connected = joined.filter((member) => member.state !== "offline");
  const totalBytes = state.files.reduce((sum, file) => sum + file.size, 0);
  const assignedBytes = state.files.reduce(
    (sum, file) => sum + file.size * (state.assignments[file.id]?.length ?? 0),
    0,
  );
  const verdicts = connected.map((member) => {
    const bytes = state.files.reduce(
      (sum, file) =>
        (state.assignments[file.id] ?? []).includes(member.id)
          ? sum + file.size
          : sum,
      0,
    );
    return { member, verdict: judgeFile(bytes, member.caps) };
  });
  const rejected = verdicts.find((entry) => entry.verdict.level === "reject");
  const warned = verdicts.find((entry) => entry.verdict.level === "warn");
  const transfers = Object.values(state.transfers);
  const busy = state.phase === "transferring" || state.phase === "paused";
  // While receiving, a send can be queued (AC11); while sending, a second
  // attempt would duplicate the same pair's job, so it waits for completion.
  const sendingOut = transfers.some((transfer) => transfer.direction === "out");
  const canSend =
    connected.length > 0 &&
    state.files.length > 0 &&
    !rejected &&
    !sendingOut &&
    state.hasKey !== false;

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
    try {
      controller.current?.sendNow();
    } catch (error) {
      useApp.getState().patch({ error: String(error) });
    }
  };

  const openNameDialog = (): void => {
    setNameDraft(state.selfName ?? "");
    setNameError(null);
    setDialog("name");
  };

  const saveName = (): void => {
    const instance = controller.current;
    if (!instance) return;
    // `rename` returns null on success, so it must not be nullish-coalesced.
    const error = instance.rename(nameDraft);
    if (error) {
      setNameError(error);
      return;
    }
    setDialog(null);
    setToast(copy.nameSaved);
    setTimeout(() => setToast(null), 2000);
  };

  const forgetName = (): void => {
    if (!controller.current) return;
    setNameDraft(controller.current.forgetName());
    setNameError(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (dialog) return;
      if (event.key === "Escape" && state.role === "admin") {
        event.preventDefault();
        setDialog("end-room");
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        startSend();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog, state.role, canSend, warned]);

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

  const incoming = state.incoming;
  const incomingRisk = incoming?.risk;

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
        <span className="user-chip" data-testid="self-chip">
          {state.selfName ?? copy.metaSelf}
          <span className="name-code">
            {state.role === "admin" ? copy.admin : copy.member}
          </span>
        </span>
        <button
          className="btn btn--ghost btn--sm"
          type="button"
          data-testid="name-edit"
          onClick={openNameDialog}
        >
          {copy.rename}
        </button>
        {state.role === "admin" ? (
          <button
            className="btn btn--ghost"
            type="button"
            onClick={() => setDialog("end-room")}
          >
            {copy.endRoom}
          </button>
        ) : (
          <button
            className="btn btn--ghost"
            type="button"
            onClick={() => {
              controller.current?.close();
              location.assign("/");
            }}
          >
            {copy.leaveRoom}
          </button>
        )}
      </header>

      <main className="shell">
        <div className="room-grid">
          <section className="stack gap-5" aria-labelledby="room-title">
            <div className="stack gap-2">
              <p className="eyebrow">
                {state.phase === "provisioning"
                  ? copy.statusConnecting
                  : state.phase === "waiting" && connected.length === 0
                    ? state.role === "admin"
                      ? copy.waitingMember
                      : copy.waitApproval
                    : busy
                      ? copy.transferInProgress
                      : memberCountText(state.members.length, MAX_MEMBERS)}
              </p>
              <h1 id="room-title" className="display">
                {state.phase === "done"
                  ? copy.done
                  : busy
                    ? copy.transferBusyTitle
                    : copy.roomTitle}
              </h1>
              <p className="lead">{copy.anyToAnyHint}</p>
              <p className="small muted">{copy.oneTransferPerPair}</p>
            </div>

            {state.versionOutdated ? (
              <div className="warn-card" role="alert">
                <Icon name="triangle-alert" />
                <div>
                  <div className="warn-card__title">{copy.versionOutdated}</div>
                  <div className="warn-card__body">
                    {copy.errorVersionOutdatedDetail}
                  </div>
                  <button
                    className="btn btn--secondary btn--sm mt-3"
                    type="button"
                    data-testid="version-reload"
                    onClick={() => location.reload()}
                  >
                    {copy.refreshPage}
                  </button>
                </div>
              </div>
            ) : null}

            {state.error && !state.roomClosed ? (
              <>
                <WarningCard title={copy.errorGeneric} body={state.error} />
                <a className="btn btn--secondary btn--block" href="/">
                  {copy.statusBackHome}
                </a>
              </>
            ) : null}
            {state.roomClosed ? (
              <>
                <WarningCard
                  title={copy.roomClosed}
                  body={state.error ?? copy.roomClosed}
                />
                <a className="btn btn--secondary btn--block" href="/">
                  {copy.statusBackHome}
                </a>
              </>
            ) : null}

            {state.sasPending && state.sas ? (
              <div className="card">
                <div className="card__head">
                  <span className="card__title">{copy.dialogSasTitle}</span>
                  <span className="spacer" />
                  <span className="card__hint">{copy.metaSasCodeHint}</span>
                </div>
                <p className="small muted">{copy.dialogSasBody}</p>
                <div
                  className="row gap-4 mt-4"
                  style={{ fontSize: 40, lineHeight: 1.2 }}
                  aria-label={copy.statusSasLabel}
                >
                  {state.sas.map((emoji, index) => (
                    <span key={index}>{emoji}</span>
                  ))}
                </div>
                {state.sasConfirmedByMe ? (
                  <p className="note mt-4">
                    <Icon name="clock" size="sm" />
                    <span>{copy.statusSasWaitingPeer}</span>
                  </p>
                ) : (
                  <button
                    className="btn btn--primary btn--lg btn--block mt-4"
                    type="button"
                    data-testid={
                      state.role === "admin"
                        ? "sas-confirm-host"
                        : "sas-confirm"
                    }
                    onClick={() => controller.current?.confirmSas()}
                  >
                    <Icon name="check" size="sm" />
                    {copy.dialogSasConfirm}
                  </button>
                )}
              </div>
            ) : null}

            {state.role === "admin" || state.phase !== "waiting" ? (
              <>
                <div
                  className={
                    dragging ? "dropzone dropzone--active" : "dropzone"
                  }
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInput.current?.click()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ")
                      fileInput.current?.click();
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
                  <span className="dropzone__icon">
                    <Icon name="upload" size="lg" />
                  </span>
                  <span
                    style={{ fontWeight: 600, color: "var(--text-primary)" }}
                  >
                    {copy.dropzone}
                  </span>
                  <span className="small muted">{copy.dropzoneHint}</span>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  data-testid="file-input"
                  onChange={(event) => {
                    pickFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </>
            ) : null}

            {state.files.length > 0 ? (
              <div className="card">
                <div className="card__head">
                  <span className="card__title">
                    {tpl(copy.statusFilesSelected, { n: state.files.length })}
                  </span>
                  <span className="card__hint">
                    {copy.totalSize} {formatBytes(totalBytes)}
                  </span>
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
                      <span className="file-tile">
                        <Icon
                          name={
                            file.mime.startsWith("video/")
                              ? "file-video"
                              : "file"
                          }
                        />
                      </span>
                      <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <span className="file-name">{file.name}</span>
                        <span className="file-meta">
                          {formatBytes(file.size)}
                        </span>
                      </span>
                      <span className="spacer" />
                      <span
                        className="row gap-1 wrap"
                        aria-label={copy.sendTo}
                        data-testid="send-target"
                      >
                        {joined.map((member) => {
                          const checked = (
                            state.assignments[file.id] ?? []
                          ).includes(member.id);
                          return (
                            <button
                              key={member.id}
                              type="button"
                              className="chip-toggle"
                              data-checked={checked}
                              data-testid={`assign-${file.id}-${member.id}`}
                              onClick={() =>
                                useApp
                                  .getState()
                                  .toggleAssignment(file.id, member.id)
                              }
                            >
                              {checked ? <Icon name="check" size="sm" /> : null}
                              {member.name}
                            </button>
                          );
                        })}
                        {joined.length === 0 ? (
                          <span className="small muted">
                            {copy.selectRecipient}
                          </span>
                        ) : null}
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
                title={copy.errorRejectedTitle}
                body={tpl(copy.errorRejectedBody, {
                  size: formatBytes(totalBytes),
                  name: rejected.member.name,
                  limit: rejected.verdict.hardLimitMB,
                })}
              />
            ) : null}
            {state.files.length > 0 && !rejected && warned ? (
              <WarningCard
                title={copy.errorOutgoingRiskTitle}
                body={tpl(copy.errorSoftLimitBody, {
                  size: formatBytes(totalBytes),
                  name: warned.member.name,
                  limit: warned.verdict.softLimitMB,
                })}
              />
            ) : null}

            {incoming ? (
              <div className="card" data-testid="incoming-card">
                <div className="card__head">
                  <span className="card__title">{copy.incomingTitle}</span>
                  <span className="spacer" />
                  <span className="card__hint">
                    {copy.incomingFrom} {incoming.peerName}
                  </span>
                </div>
                <ul className="file-list">
                  {incoming.files.map((file) => (
                    <li className="file-row" key={file.id}>
                      <span className="file-tile">
                        <Icon
                          name={
                            file.mime.startsWith("video/")
                              ? "file-video"
                              : "file-text"
                          }
                        />
                      </span>
                      <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <span className="file-name">{file.name}</span>
                        <span className="file-meta">
                          {formatBytes(file.size)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="small muted mt-3">
                  {tpl(copy.statusIncomingSummary, {
                    size: formatBytes(incoming.totalBytes),
                    n: incoming.files.length,
                  })}
                </p>
                {incomingRisk?.level === "warn" ? (
                  <div className="mt-4">
                    <WarningCard
                      title={copy.errorIncomingRiskTitle}
                      body={incomingRisk.message}
                    />
                  </div>
                ) : null}
                <div className="row gap-3 mt-4">
                  <button
                    className="btn btn--primary btn--lg btn--block"
                    type="button"
                    data-testid="accept"
                    onClick={() => {
                      if (incomingRisk?.level === "warn") setRiskDialog(true);
                      else controller.current?.acceptIncoming();
                    }}
                  >
                    <Icon name="arrow-right" size="sm" />
                    {incomingRisk?.level === "warn"
                      ? copy.dialogRiskConfirm
                      : copy.acceptFiles}
                  </button>
                  <button
                    className="btn btn--ghost btn--lg"
                    type="button"
                    data-testid="decline-incoming"
                    onClick={() => controller.current?.declineIncoming()}
                  >
                    {copy.decline}
                  </button>
                </div>
                <p className="note mt-4">
                  <Icon name="lock" size="sm" />
                  <span>{copy.privacyNote}</span>
                </p>
                <p className="small muted">{copy.confirmEveryReceive}</p>
              </div>
            ) : null}

            {transfers.map((transfer) => (
              <article
                className="card transfer"
                key={transfer.peerId}
                data-testid={`transfer-${transfer.direction}`}
              >
                <div className="transfer__head">
                  <span className="file-tile">
                    <Icon
                      name={
                        transfer.files[0]?.mime.startsWith("video/")
                          ? "file-video"
                          : "file"
                      }
                    />
                  </span>
                  <span className="transfer__body">
                    <span className="file-name">
                      {transfer.files.length > 1
                        ? tpl(copy.metaFileListMore, {
                            name: transfer.files[0]?.name ?? "",
                            n: transfer.files.length,
                          })
                        : (transfer.files[0]?.name ?? "")}
                    </span>
                    <span className="transfer__route">
                      {transfer.direction === "out" ? (
                        <>
                          <strong>{copy.metaSelf}</strong>
                          <Icon name="arrow-right" size="sm" />
                          <strong>
                            {state.members.find(
                              (member) => member.id === transfer.peerId,
                            )?.name ?? copy.metaPeer}
                          </strong>
                        </>
                      ) : (
                        <>
                          <strong>
                            {state.members.find(
                              (member) => member.id === transfer.peerId,
                            )?.name ?? copy.metaPeer}
                          </strong>
                          <Icon name="arrow-right" size="sm" />
                          <strong>{copy.metaSelf}</strong>
                        </>
                      )}
                    </span>
                  </span>
                  {transfer.path ? <PathBadge path={transfer.path} /> : null}
                </div>
                <Progress
                  sentBytes={transfer.sentBytes}
                  totalBytes={transfer.totalBytes}
                  speedBps={transfer.speedBps}
                  path={transfer.path}
                />
              </article>
            ))}

            {state.queue.map((entry, index) => (
              <article
                className="card transfer transfer--queued"
                key={`${entry.peerId}-${index}`}
                data-testid="queue-item"
              >
                <div className="transfer__head">
                  <span className="file-tile">
                    <Icon name="clock" />
                  </span>
                  <span className="transfer__body">
                    <span className="file-name">
                      {entry.files[0]?.name ?? ""}
                    </span>
                    <span className="transfer__route">
                      <strong>{copy.metaSelf}</strong>
                      <Icon name="arrow-right" size="sm" />
                      <strong>
                        {state.members.find(
                          (member) => member.id === entry.peerId,
                        )?.name ?? copy.metaPeer}
                      </strong>
                    </span>
                  </span>
                  <span className="pill">{copy.queued}</span>
                </div>
                <p className="note">{copy.busyRetry}</p>
              </article>
            ))}

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
                {state.result.sha256 ? (
                  <p
                    className="code-block small mono"
                    style={{ wordBreak: "break-all", marginTop: 8 }}
                  >
                    {state.result.sha256}
                  </p>
                ) : null}
                {state.result.path ? (
                  <p className="small muted mt-4">
                    {copy.statusSavedTo}{" "}
                    <span className="mono">{state.result.path}</span>
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
                  <span>{copy.roomStillLive}</span>
                </p>
                <a className="btn btn--secondary btn--block" href="/room">
                  {copy.backToRoom}
                </a>
              </div>
            ) : null}

            <div className="signal-rule" aria-hidden="true" />
            <p className="small muted">
              {copy.metaRoomFooter} <a href="/privacy">{copy.privacyLink}</a>
            </p>
          </section>

          <aside className="stack gap-4">
            {state.role === "admin" ? (
              <section className="card qr-card" aria-labelledby="qr-title">
                <div className="card__head" style={{ marginBottom: 0 }}>
                  <span className="card__title" id="qr-title">
                    {copy.inviteTitle}
                  </span>
                  <span className="spacer" />
                  <span className="pill pill--secure">
                    <Icon name="lock" size="sm" />
                    <span>{copy.adminOnly}</span>
                  </span>
                </div>

                <div className="qr-frame" role="img" aria-label={copy.qrAlt}>
                  {qrSvg ? (
                    <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
                  ) : null}
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
                  <span
                    className="code-digits"
                    aria-label={tpl(copy.statusRoomCodeLabel, {
                      code: state.code ?? "",
                    })}
                  >
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
                    {copy.metaInviteOtherDevice}{" "}
                    <span className="mono">{location.origin}/code</span>{" "}
                    {copy.metaEnterRoomCode}
                  </span>
                </p>
              </section>
            ) : null}

            <section className="card" aria-labelledby="members-title">
              <div className="card__head">
                <span className="card__title" id="members-title">
                  {memberCountText(state.members.length, MAX_MEMBERS)}
                </span>
                <span className="spacer" />
                <span className="card__hint">
                  {state.role === "admin" ? copy.joinCardHint : copy.member}
                </span>
              </div>

              {state.members.length <= 1 ? (
                <p className="small muted">
                  {state.role === "admin"
                    ? copy.roomWaitingMembers
                    : copy.waitingMember}
                </p>
              ) : (
                <ul className="receiver-list">
                  {state.members.map((member) => {
                    const isSelf = member.id === state.selfId;
                    return (
                      <li
                        className={
                          member.state === "pending"
                            ? "receiver receiver--pending"
                            : isSelf
                              ? "receiver receiver--self"
                              : "receiver"
                        }
                        key={member.id}
                        data-testid="member-row"
                        data-member-id={member.id}
                      >
                        <span className="receiver__tile">
                          <Icon
                            name={
                              member.caps.screen === "phone"
                                ? "smartphone"
                                : "laptop"
                            }
                          />
                        </span>
                        <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                          <span className="receiver__name">
                            {isSelf ? copy.metaSelfWithSep : ""}
                            {member.name}
                          </span>
                          <span className="receiver__meta">
                            {memberLabel(member.caps)} · {stateText(member)}
                          </span>
                        </span>
                        <span className="spacer" />
                        {member.state === "pending" &&
                        state.role === "admin" ? (
                          <span className="receiver__actions">
                            <button
                              className="btn btn--primary btn--sm"
                              type="button"
                              data-testid="approve"
                              onClick={() =>
                                controller.current?.approve(member.id)
                              }
                            >
                              {copy.approve}
                            </button>
                            <button
                              className="btn btn--ghost btn--sm"
                              type="button"
                              onClick={() =>
                                controller.current?.deny(member.id)
                              }
                            >
                              {copy.deny}
                            </button>
                          </span>
                        ) : member.path ? (
                          <PathBadge path={member.path} />
                        ) : null}
                        {member.state === "joined" &&
                        !isSelf &&
                        state.role === "admin" ? (
                          <button
                            className="icon-btn"
                            type="button"
                            aria-label={`${copy.remove} ${member.name}`}
                            data-testid={`remove-${member.id}`}
                            onClick={() => {
                              setRemoveTarget(member.id);
                              setDialog("remove");
                            }}
                          >
                            <Icon name="x" size="sm" />
                          </button>
                        ) : null}
                        {member.progress && member.progress.totalBytes > 0 ? (
                          <Progress
                            compact
                            sentBytes={member.progress.sentBytes}
                            totalBytes={member.progress.totalBytes}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {pending.length > 0 ? (
                <p className="note mt-4">
                  <Icon name="clock" size="sm" />
                  <span>{copy.approveHint}</span>
                </p>
              ) : null}
            </section>

            {busy || transfers.length > 0 ? (
              <section className="card" aria-labelledby="session-title">
                <div className="card__head">
                  <span className="card__title" id="session-title">
                    {copy.howThisRoomWorks}
                  </span>
                  <span className="spacer" />
                  <span className="pill pill--secure">
                    <Icon name="shield-check" size="sm" />
                    <span>{copy.secure}</span>
                  </span>
                </div>
                <dl className="kv">
                  <div className="kv__row">
                    <dt>{copy.metaLabelTransfer}</dt>
                    <dd>
                      {tpl(copy.statusActiveTransfers, {
                        n: transfers.length,
                      })}
                      {state.queue.length > 0
                        ? tpl(copy.statusQueuedSuffix, {
                            n: state.queue.length,
                          })
                        : ""}
                    </dd>
                  </div>
                  <div className="kv__row">
                    <dt>{copy.metaLabelEncryption}</dt>
                    <dd>{copy.metaEncryptionValue}</dd>
                  </div>
                  <div className="kv__row">
                    <dt>{copy.metaLabelIntegrity}</dt>
                    <dd>{copy.metaIntegrityValue}</dd>
                  </div>
                  <div className="kv__row">
                    <dt>{copy.metaLabelServer}</dt>
                    <dd>{copy.metaServerValue}</dd>
                  </div>
                </dl>
              </section>
            ) : null}
          </aside>
        </div>
      </main>

      <div className="sticky-bar">
        <span className="small secondary">
          {connected.length > 0
            ? tpl(copy.statusSendSummary, {
                n: connected.length,
                size: formatBytes(assignedBytes || totalBytes),
              })
            : copy.emptyReceivers}
        </span>
        <span className="spacer" />
        <button
          className="btn btn--secondary"
          type="button"
          onClick={() => fileInput.current?.click()}
        >
          <Icon name="plus" size="sm" />
          {copy.addFile}
        </button>
        <button
          className="btn btn--primary btn--lg"
          type="button"
          data-testid="start-send"
          disabled={!canSend}
          onClick={startSend}
        >
          <Icon name="arrow-right" size="sm" />
          {busy ? copy.transferInProgress : copy.startSend}
        </button>
      </div>

      <Dialog
        open={dialog === "end-room"}
        title={copy.dialogEndRoomTitle}
        confirmLabel={copy.endRoom}
        danger
        onConfirm={() => {
          setDialog(null);
          controller.current?.close();
          location.assign("/");
        }}
        onCancel={() => setDialog(null)}
      >
        {copy.dialogEndRoomBody}
      </Dialog>

      <Dialog
        open={dialog === "send-warn"}
        title={copy.dialogSendWarnTitle}
        confirmLabel={copy.dialogSendWarnConfirm}
        onConfirm={() => {
          setDialog(null);
          try {
            controller.current?.sendNow();
          } catch (error) {
            useApp.getState().patch({ error: String(error) });
          }
        }}
        onCancel={() => setDialog(null)}
      >
        {tpl(copy.dialogSendWarnBody, {
          size: formatBytes(totalBytes),
          limit: warned?.verdict.softLimitMB ?? 150,
        })}
      </Dialog>

      <Dialog
        open={dialog === "remove"}
        title={copy.dialogRemoveTitle}
        confirmLabel={copy.remove}
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
        {copy.dialogRemoveBody}
      </Dialog>

      <Dialog
        open={dialog === "name"}
        title={copy.nameDialogTitle}
        confirmLabel={copy.nameSave}
        confirmTestId="name-save"
        onConfirm={saveName}
        onCancel={() => setDialog(null)}
      >
        <p className="small muted">{copy.nameHint}</p>
        <label className="field mt-3">
          <span className="field__label">{copy.dialogNameLabel}</span>
          <input
            className="input"
            value={nameDraft}
            maxLength={32}
            data-testid="name-input"
            onChange={(event) => {
              setNameError(null);
              setNameDraft(event.target.value);
            }}
          />
        </label>
        {nameError ? (
          <p className="small" style={{ color: "var(--danger-text)" }}>
            {nameError}
          </p>
        ) : null}
        <button
          className="btn btn--ghost btn--sm mt-3"
          type="button"
          data-testid="name-forget"
          onClick={forgetName}
        >
          {copy.nameForget}
        </button>
      </Dialog>

      <Dialog
        open={riskDialog}
        title={copy.dialogRiskTitle}
        confirmLabel={copy.dialogRiskConfirm}
        onConfirm={() => {
          setRiskDialog(false);
          controller.current?.acceptIncoming();
        }}
        onCancel={() => setRiskDialog(false)}
      >
        {incomingRisk?.message ?? copy.dialogRiskBody}
        <br />
        {copy.dialogRiskHint}
      </Dialog>

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
      {state.notice ? (
        <p className="sr-only" role="status">
          {state.notice}
        </p>
      ) : null}
    </div>
  );
}
