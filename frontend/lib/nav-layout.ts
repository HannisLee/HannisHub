import type { NavGroup, NavItem } from "./navigation";

/** 侧栏本地布局（分组顺序、组内条目顺序与折叠状态），与后端完全解耦 */
export interface NavLayoutState {
  groupOrder: string[];
  itemOrder: Record<string, string[]>;
  collapsedGroups: string[];
}

const NAV_LAYOUT_STORAGE_KEY = "hannishub_nav_layout";
const NAV_LAYOUT_CHANGE_EVENT = "hannishub:nav-layout-change";

const EMPTY_LAYOUT: NavLayoutState = { groupOrder: [], itemOrder: {}, collapsedGroups: [] };

let cachedRaw: string | null = null;
let cachedLayout: NavLayoutState = EMPTY_LAYOUT;

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function parseLayout(raw: string | null): NavLayoutState {
  if (!raw) return EMPTY_LAYOUT;
  try {
    const value = JSON.parse(raw) as Partial<NavLayoutState> | null;
    if (!value || typeof value !== "object") return EMPTY_LAYOUT;
    const itemOrder: Record<string, string[]> = {};
    if (value.itemOrder && typeof value.itemOrder === "object") {
      for (const [groupId, order] of Object.entries(value.itemOrder)) {
        if (groupId) itemOrder[groupId] = uniqueStrings(order);
      }
    }
    return {
      groupOrder: uniqueStrings(value.groupOrder),
      itemOrder,
      collapsedGroups: uniqueStrings(value.collapsedGroups),
    };
  } catch {
    return EMPTY_LAYOUT;
  }
}

/** 读取本地布局；同一份字符串复用解析结果，保证 useSyncExternalStore 快照稳定 */
export function readNavLayout(): NavLayoutState {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(NAV_LAYOUT_STORAGE_KEY);
  } catch {
    return EMPTY_LAYOUT;
  }
  if (raw === cachedRaw) return cachedLayout;
  cachedRaw = raw;
  cachedLayout = parseLayout(raw);
  return cachedLayout;
}

export function subscribeNavLayout(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === NAV_LAYOUT_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(NAV_LAYOUT_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(NAV_LAYOUT_CHANGE_EVENT, onChange);
  };
}

/** 写入本地布局并通知侧栏重新渲染 */
export function updateNavLayout(updater: (current: NavLayoutState) => NavLayoutState): void {
  const next = updater(readNavLayout());
  try {
    window.localStorage.setItem(NAV_LAYOUT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(NAV_LAYOUT_CHANGE_EVENT));
}

function sortByStoredOrder<T>(items: T[], storedKeys: string[] | undefined, keyOf: (item: T) => string): T[] {
  if (!storedKeys?.length) return items;
  const rank = new Map(storedKeys.map((key, index) => [key, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(keyOf(item)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.item);
}

export function orderNavGroups(groups: NavGroup[], layout: NavLayoutState): NavGroup[] {
  return sortByStoredOrder(groups, layout.groupOrder, group => group.id);
}

export function orderNavItems(items: NavItem[], groupId: string, layout: NavLayoutState): NavItem[] {
  return sortByStoredOrder(items, layout.itemOrder[groupId], item => item.href);
}

export function isNavGroupCollapsed(layout: NavLayoutState, groupId: string): boolean {
  return layout.collapsedGroups.includes(groupId);
}

/** 把某个 key 移动到目标 key 之前；目标不存在时放到末尾 */
export function moveKeyBefore(keys: string[], source: string, target: string): string[] {
  if (source === target) return keys;
  const next = keys.filter(key => key !== source);
  const targetIndex = next.indexOf(target);
  if (targetIndex < 0) next.push(source);
  else next.splice(targetIndex, 0, source);
  return next;
}
