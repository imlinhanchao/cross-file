import { useEffect, useRef, useState } from "react";
import { copy } from "@crossfile/ui";
import { parseRoomLink, normalizeJoinCode } from "@crossfile/core";
import { Icon } from "../ui/Icon.js";

/** `/` and `/code` — create a room or join one (docs/02 v2, ADR 0010). */
export function EntryPage({ focusCode = false }: { focusCode?: boolean }) {
  const [digits, setDigits] = useState("");
  const [link, setLink] = useState("");
  const [showLink, setShowLink] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusCode) codeInput.current?.focus();
  }, [focusCode]);

  const createRoom = (): void => {
    // Keep dev/diagnostic query parameters across the navigation.
    location.assign(`/room${location.search}`);
  };

  const joinByCode = (event: React.FormEvent): void => {
    event.preventDefault();
    const code = normalizeJoinCode(digits);
    if (!code) {
      setError(copy.entryCodeRequired);
      return;
    }
    location.assign(`/j/${code}${location.search}`);
  };

  const joinByLink = (event: React.FormEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const raw = link.trim();
    if (!raw) {
      setPasteError(copy.entryLinkPasteRequired);
      return;
    }
    const parsed = parseRoomLink(raw);
    if (!parsed) {
      // Relative links (`/r/<roomId>#<key>`) have no origin of their own.
      const resolved = parseRoomLink(new URL(raw, location.origin).toString());
      if (!resolved) {
        setPasteError(copy.entryLinkMissingKey);
        return;
      }
      const path = `/r/${resolved.roomId}#${raw.split("#")[1] ?? ""}`;
      location.assign(path);
      return;
    }
    setPasteError(null);
    location.assign(raw);
  };

  const openLinkForm = (): void => {
    setShowLink(true);
    setPasteError(null);
    setTimeout(() => linkInput.current?.focus(), 0);
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
          <span>{copy.entryServerTitle}</span>
        </span>
        <span className="topbar__spacer" />
        <a className="btn btn--ghost btn--sm" href="/privacy">
          <Icon name="lock" size="sm" />
          {copy.privacyLink}
        </a>
      </header>

      <main className="shell">
        <div className="entry-grid">
          <section className="entry-hero" aria-labelledby="entry-title">
            <p className="eyebrow">{copy.entryEyebrow}</p>
            <h1 id="entry-title" className="display">
              {copy.entryTitle}
            </h1>
            <p className="lead">{copy.entryLead}</p>

            <div className="signal-rule mt-5" aria-hidden="true" />

            <ul className="entry-features">
              <li className="entry-feature">
                <span className="entry-feature__tile">
                  <Icon name="shield-check" />
                </span>
                <span className="stack" style={{ gap: 2 }}>
                  <span className="entry-feature__title">{copy.secure}</span>
                  <span className="entry-feature__body">
                    {copy.entryFeatureSecureBody}
                  </span>
                </span>
              </li>
              <li className="entry-feature">
                <span className="entry-feature__tile">
                  <Icon name="lock" />
                </span>
                <span className="stack" style={{ gap: 2 }}>
                  <span className="entry-feature__title">
                    {copy.entryServerTitle}
                  </span>
                  <span className="entry-feature__body">
                    {copy.entryFeatureServerBody}
                  </span>
                </span>
              </li>
              <li className="entry-feature">
                <span className="entry-feature__tile">
                  <Icon name="smartphone" />
                </span>
                <span className="stack" style={{ gap: 2 }}>
                  <span className="entry-feature__title">
                    {copy.entryFeatureBidirectional}
                  </span>
                  <span className="entry-feature__body">
                    {copy.entryFeatureBidirectionalBody}
                  </span>
                </span>
              </li>
            </ul>

            <p className="note mt-5">
              <Icon name="globe" size="sm" />
              <span>{copy.entryOpenSource}</span>
            </p>
          </section>

          <section className="card" aria-labelledby="action-title">
            <div className="card__head">
              <span className="card__title" id="action-title">
                {copy.actionTitle}
              </span>
              <span className="spacer" />
              <span className="pill pill--secure">
                <Icon name="wifi" size="sm" />
                <span>{copy.lanFirst}</span>
              </span>
            </div>

            <button
              className="btn btn--primary btn--lg btn--block"
              type="button"
              data-testid="create-room"
              onClick={createRoom}
            >
              <Icon name="plus" size="sm" />
              {copy.createRoom}
            </button>
            <p className="small muted mt-2">{copy.entryCreateHint}</p>

            <div className="divider-label mt-5 mb-4">
              <span>{copy.joinDivider}</span>
            </div>

            <form className="field" onSubmit={joinByCode}>
              <label className="field__label" htmlFor="join-code">
                {copy.enterRoomCode}
              </label>
              <div className="field__row">
                <input
                  id="join-code"
                  ref={codeInput}
                  className="input mono input--code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={12}
                  placeholder="000 000"
                  value={digits}
                  data-testid={focusCode ? "code-input" : "join-code-input"}
                  onChange={(event) => {
                    setError(null);
                    setDigits(
                      event.target.value.replace(/[^0-9]/g, "").slice(0, 6),
                    );
                  }}
                />
                <button
                  className="btn btn--secondary"
                  type="submit"
                  data-testid="code-submit"
                >
                  <Icon name="arrow-right" size="sm" />
                  {copy.joinRoom}
                </button>
              </div>
              {error ? (
                <p className="small" style={{ color: "var(--danger-text)" }}>
                  {error}
                </p>
              ) : null}
            </form>

            {showLink ? (
              <form className="field mt-3" onSubmit={joinByLink}>
                <label className="field__label" htmlFor="join-link">
                  {copy.entryInviteLinkLabel}
                </label>
                <div className="field__row">
                  <input
                    id="join-link"
                    ref={linkInput}
                    className="input mono"
                    placeholder="https://…/r/… #…"
                    value={link}
                    data-testid="join-link-input"
                    onChange={(event) => {
                      setPasteError(null);
                      setLink(event.target.value);
                    }}
                  />
                  <button
                    className="btn btn--secondary"
                    type="submit"
                    data-testid="join-link-submit"
                  >
                    <Icon name="arrow-right" size="sm" />
                    {copy.entryOpenButton}
                  </button>
                </div>
                {pasteError ? (
                  <p className="small" style={{ color: "var(--danger-text)" }}>
                    {pasteError}
                  </p>
                ) : null}
              </form>
            ) : (
              <button
                className="btn btn--ghost btn--block mt-3"
                type="button"
                onClick={openLinkForm}
              >
                <Icon name="link" size="sm" />
                {copy.pasteInviteLink}
              </button>
            )}

            <div className="signal-rule mt-5" aria-hidden="true" />
            <p className="note mt-4">
              <Icon name="shield-check" size="sm" />
              <span>{copy.privacyShort}</span>
            </p>
            <p className="note">
              <Icon name="link" size="sm" />
              <span>{copy.inviteOnlyAdmin}</span>
            </p>
          </section>
        </div>

        <footer className="row gap-4 wrap mt-7">
          <span className="small muted">CrossFile · MIT</span>
          <span className="spacer" />
          <a className="small" href="/privacy">
            {copy.privacyLink}
          </a>
        </footer>
      </main>
    </div>
  );
}
