import { formatBytes, formatSpeed, pathLabel } from "@crossfile/ui";
import type { PathLabel } from "@crossfile/core";
import { Icon } from "./Icon.js";

export function PathBadge({ path }: { path: PathLabel }) {
  const modifier =
    path === "lan"
      ? "path-badge--lan"
      : path === "direct"
        ? "path-badge--direct"
        : "path-badge--relay";
  return (
    <span
      className={`path-badge ${modifier}`}
      aria-label={`当前路径：${pathLabel(path)}`}
    >
      <span className="dot" />
      {pathLabel(path)}
    </span>
  );
}

export interface ProgressProps {
  sentBytes: number;
  totalBytes: number;
  speedBps?: number;
  path?: PathLabel;
  compact?: boolean;
}

export function Progress({
  sentBytes,
  totalBytes,
  speedBps,
  path,
  compact,
}: ProgressProps) {
  const ratio = totalBytes > 0 ? Math.min(1, sentBytes / totalBytes) : 0;
  const percent = Math.round(ratio * 100);

  if (compact) {
    return (
      <span
        className="mini-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className="mini-bar" style={{ width: `${percent}%` }} />
      </span>
    );
  }

  return (
    <div className="progress">
      <div className="progress__head">
        <span className="progress__value tnum">{percent}%</span>
        <span className="small secondary tnum">
          {formatBytes(sentBytes)} / {formatBytes(totalBytes)}
        </span>
        <span className="spacer" />
        {path ? <PathBadge path={path} /> : null}
      </div>
      <div
        className="progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="传输进度"
      >
        <div className="progress__bar" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress__meta">
        {speedBps ? (
          <span className="tnum">{formatSpeed(speedBps)}</span>
        ) : null}
        <span>已传 {formatBytes(sentBytes)}</span>
      </div>
    </div>
  );
}

export function WarningCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="warn-card" role="alert">
      <Icon name="triangle-alert" />
      <div>
        <div className="warn-card__title">{title}</div>
        <div className="warn-card__body">{body}</div>
      </div>
    </div>
  );
}
