import { useState } from "react";
import { copy } from "@crossfile/ui";
import { Icon } from "../ui/Icon.js";

/** `/code` — enter the 6 digit room code (docs/01 §4 step 1, docs/02 §3.5). */
export function CodePage() {
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const code = digits.replace(/[^0-9]/g, "");
    if (code.length !== 6) {
      setError("请输入 6 位数字码");
      return;
    }
    location.assign(`/j/${code}`);
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
      </header>

      <main className="shell">
        <form className="card stack gap-4" style={{ maxWidth: 420, margin: "48px auto 0" }} onSubmit={submit}>
          <div className="stack gap-2">
            <p className="eyebrow">输入房间码</p>
            <h1 className="h2">输入对方屏幕上的 6 位码</h1>
            <p className="small muted">10 分钟内有效。加入后需要和对方核对 4 个图标，密钥才会通过加密通道送来。</p>
          </div>
          <label className="stack gap-2">
            <span className="eyebrow">房间码</span>
            <input
              className="input code-digits"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={digits}
              data-testid="code-input"
              onChange={(event) => {
                setError(null);
                setDigits(event.target.value.replace(/[^0-9]/g, "").slice(0, 6));
              }}
              placeholder="482913"
              style={{ letterSpacing: "0.16em", fontFamily: "var(--font-mono)", fontSize: "2rem" }}
            />
          </label>
          {error ? <p className="small" style={{ color: "var(--danger-text)" }}>{error}</p> : null}
          <button className="btn btn--primary btn--lg btn--block" type="submit" data-testid="code-submit">
            <Icon name="arrow-right" size="sm" />
            加入房间
          </button>
          <p className="note">
            <Icon name="lock" size="sm" />
            <span>{copy.privacyShort}</span>
          </p>
        </form>
      </main>
    </div>
  );
}
