export function formatBytes(value: number | null | undefined): string {
  const bytes = Number(value || 0);
  if (!bytes) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatMemMb(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const mb = Number(value);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

export function formatShortDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("zh-CN");
}

export function formatPercent(value: number | null | undefined): string {
  return `${Math.max(0, Math.min(100, Number(value || 0))).toFixed(0)}%`;
}

export function clampPercent(value: number | null | undefined): number {
  return Math.max(0, Math.min(100, Number(value || 0)));
}

export function truncate(value: string | null | undefined, length = 120): string {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请稍后重试";
}
