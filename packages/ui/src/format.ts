const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** "486.2 MB · 视频" style numbers: tabular, one decimal above 100 MB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= 100 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  const mbps = (bytesPerSecond * 8) / 1_000_000;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  return `${Math.max(0, Math.min(100, Math.round(ratio * 100)))}%`;
}

export function splitCode(code: string): string {
  const clean = code.replace(/[^0-9]/g, "");
  return clean.length === 6 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean;
}

export function mimeLabel(file: { name: string; mime: string }): string {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.mime.startsWith("video/")) return "视频";
  if (file.mime.startsWith("image/")) return "图片";
  if (file.mime.startsWith("audio/")) return "音频";
  if (file.mime.includes("pdf") || ext === "pdf") return "PDF";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "压缩包";
  if (["md", "txt", "doc", "docx"].includes(ext)) return "文档";
  return "文件";
}
