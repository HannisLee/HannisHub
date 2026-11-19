/** 待办进度时间轴与排序纯函数（无浏览器副作用，便于单元测试）。 */

export interface ProgressRecord {
  id: string;
  text: string;
  created_at: number;
}

export interface TimelineItem {
  id: string;
  text: string;
  createdAt: number | null;
  isoTime: string | null;
  kind: "anchor" | "same-day" | "unknown";
  dateText: string;
  dateTimeText: string;
  timeText: string;
  deltaText: string;
}

export type TodoSortMode = "manual" | "priority" | "updated" | "due";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isValidTimestamp(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return false;
  return !Number.isNaN(new Date(value * 1000).getTime());
}

/** 将进度记录按真实时间戳从早到晚排序；相同时间戳保持原有相对顺序。 */
export function sortProgressEntries<T extends ProgressRecord>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index, valid: isValidTimestamp(entry.created_at) }))
    .sort((a, b) => {
      if (a.valid && b.valid) {
        return a.entry.created_at - b.entry.created_at || a.index - b.index;
      }
      if (a.valid !== b.valid) return a.valid ? -1 : 1;
      return a.index - b.index;
    })
    .map(item => item.entry);
}

/** 合并两组进度记录（按 id 去重）并保持时间顺序稳定。 */
export function mergeProgressEntries<T extends ProgressRecord>(saved: readonly T[], current: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of saved) byId.set(entry.id, entry);
  for (const entry of current) byId.set(entry.id, entry);
  return sortProgressEntries([...byId.values()]);
}

/** 将秒数间隔格式化为紧凑短格式（如 +5m、+1h30m、+<1m）。 */
export function formatDurationShort(diffSeconds: number): string {
  if (!Number.isFinite(diffSeconds) || diffSeconds < 0) return "";
  if (diffSeconds < 60) return "+<1m";
  const totalMinutes = Math.floor(diffSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `+${minutes}m`;
  if (minutes === 0) return `+${hours}h`;
  return `+${hours}h${minutes}m`;
}

/** 构建完整进度时间轴：首条与跨日显示 YYYY-MM-DD 与 HH:mm，同日后续显示 +时长 与 HH:mm。 */
export function buildProgressTimeline(entries: readonly ProgressRecord[]): TimelineItem[] {
  const sorted = sortProgressEntries(entries);
  let prevValid: { createdAt: number; dayKey: string } | null = null;

  return sorted.map(entry => {
    if (!isValidTimestamp(entry.created_at)) {
      prevValid = null;
      return {
        id: entry.id,
        text: entry.text,
        createdAt: null,
        isoTime: null,
        kind: "unknown",
        dateText: "时间未知",
        dateTimeText: "时间未知",
        timeText: "—",
        deltaText: "",
      };
    }

    const date = new Date(entry.created_at * 1000);
    const dayKey = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    const timeText = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    const dateTimeText = `${dayKey} ${timeText}`;
    const isoTime = date.toISOString();

    if (prevValid !== null && prevValid.dayKey === dayKey) {
      const diffSeconds = Math.max(0, entry.created_at - prevValid.createdAt);
      const deltaText = formatDurationShort(diffSeconds);
      prevValid = { createdAt: entry.created_at, dayKey };
      return {
        id: entry.id,
        text: entry.text,
        createdAt: entry.created_at,
        isoTime,
        kind: "same-day",
        dateText: "",
        dateTimeText,
        timeText,
        deltaText,
      };
    }

    prevValid = { createdAt: entry.created_at, dayKey };
    return {
      id: entry.id,
      text: entry.text,
      createdAt: entry.created_at,
      isoTime,
      kind: "anchor",
      dateText: dayKey,
      dateTimeText,
      timeText,
      deltaText: "",
    };
  });
}

export interface SortableTodo {
  priority: number;
  due_date: string;
  sort: number;
  created_at: number;
  updated_at: number;
}

/** 按指定模式稳定排序待办。 */
export function sortTodoItems<T extends SortableTodo>(items: readonly T[], mode: TodoSortMode = "manual"): T[] {
  const copy = [...items];
  const byManual = (a: T, b: T) => a.sort - b.sort || a.created_at - b.created_at;
  if (mode === "due") {
    copy.sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999") || byManual(a, b));
  } else if (mode === "priority") {
    copy.sort((a, b) => (b.priority || 2) - (a.priority || 2) || byManual(a, b));
  } else if (mode === "updated") {
    copy.sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at) || byManual(a, b));
  } else {
    copy.sort(byManual);
  }
  return copy;
}

/** 阻塞中的任务稳定置顶：组内其余条目保持传入顺序（通常为手动顺序）。 */
export function blockedFirst<T extends { status?: string }>(items: readonly T[]): T[] {
  return [...items.filter(item => item.status === "blocked"), ...items.filter(item => item.status !== "blocked")];
}
