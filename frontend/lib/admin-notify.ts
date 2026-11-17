/** 管理员跨页面私聊与桌面提醒；只在管理员外壳启用，未读数以服务端为准。 */
import { getLastRead, messagePreview, playChatDing } from "./chat-notify";
import type { ChatRoomMessage } from "./types";

const DESKTOP_KEY = "hannishub_admin_desktop_notify";
const CLAIM_KEY = "hannishub_admin_message_alerts";
export const ADMIN_OPEN_CHAT_EVENT = "hannishub-admin-open-chat";
export const ADMIN_PRIVATE_VIEW_EVENT = "hannishub-admin-private-view";

export interface AdminContact {
  id: string;
  name: string;
  unread: number;
  last_incoming_seq: number;
  last_incoming: string;
}

export interface AdminAlert { title: string; body: string; contact?: string }
interface State { unread: number; toast: AdminAlert | null; contact: string | null; latest: string | null; desktop: boolean }
const serverState: State = { unread: 0, toast: null, contact: null, latest: null, desktop: false };
let state = serverState;
let loaded = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const seenPrivate = new Map<string, number>();
let baseline = false;
const claims = new Map<string, number>();
let viewedContact: string | null = null;

export function subscribeAdminNotify(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getAdminNotifyServerSnapshot() { return serverState; }
export function getAdminNotifySnapshot() {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    try { state = { ...state, desktop: localStorage.getItem(DESKTOP_KEY) === "on" }; } catch { /* 禁用存储时仅本页保存 */ }
  }
  return state;
}
function update(next: Partial<State>) { state = { ...state, ...next }; listeners.forEach(listener => listener()); }

export function setAdminDesktop(enabled: boolean) {
  try { localStorage.setItem(DESKTOP_KEY, enabled ? "on" : "off"); } catch { /* 本页仍然有效 */ }
  update({ desktop: enabled });
}
export function setViewedPrivate(contact: string | null) { viewedContact = contact; }
export function dismissAdminToast() { clearTimeout(toastTimer); update({ toast: null }); }
export function openAdminPrivate(contact: string | null) { update({ contact, toast: null }); }
export function openAdminAlert(alert: AdminAlert) {
  dismissAdminToast();
  if (alert.contact) openAdminPrivate(alert.contact);
  else window.dispatchEvent(new Event(ADMIN_OPEN_CHAT_EVENT));
}

/** Web Locks 保证多个标签页只提醒一次；旧浏览器与禁用存储时退回尽力去重。 */
async function deliver(key: string, seq: number, alert: AdminAlert, room = false) {
  const notify = () => {
    let ledger: Record<string, number> = {};
    try { ledger = JSON.parse(localStorage.getItem(CLAIM_KEY) || "{}"); if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) ledger = {}; } catch { /* 使用内存去重 */ }
    if (seq <= Math.max(claims.get(key) || 0, Number(ledger[key]) || 0)) return;
    claims.set(key, seq);
    ledger[key] = seq;
    try { localStorage.setItem(CLAIM_KEY, JSON.stringify(Object.fromEntries(Object.entries(ledger).slice(-256)))); } catch { /* 使用内存去重 */ }
    if (room && seq <= getLastRead()) return;
    if (alert.contact === viewedContact && !document.hidden && document.hasFocus()) return;
    update({ toast: alert });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => update({ toast: null }), 8000);
    playChatDing();
    if (!getAdminNotifySnapshot().desktop || (!document.hidden && document.hasFocus()) || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const notification = new Notification(alert.title, { body: alert.body.slice(0, 240), tag: `hannishub-admin-${key}`, icon: "/icon.svg", silent: true });
      notification.onclick = () => { window.focus(); openAdminAlert(alert); notification.close(); };
      setTimeout(() => notification.close(), 20000);
    } catch { /* 系统通知不可用时仍保留提示音、网页提示和标签页未读 */ }
  };
  if (navigator.locks) {
    try { await navigator.locks.request("hannishub-admin-message-alert", notify); } catch { notify(); }
  } else notify();
}

export function adminRoomAlert(messages: readonly ChatRoomMessage[]) {
  const message = messages.at(-1);
  if (message) void deliver("room", message.id, { title: `聊天室 · ${message.nickname}`, body: messagePreview(message) }, true);
}

export function updateAdminContacts(contacts: AdminContact[]) {
  const latest = [...contacts].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.last_incoming_seq - a.last_incoming_seq)[0]?.id ?? null;
  update({ unread: contacts.reduce((sum, contact) => sum + contact.unread, 0), latest });
  for (const contact of contacts) {
    const seen = seenPrivate.get(contact.id) || 0;
    seenPrivate.set(contact.id, Math.max(seen, contact.last_incoming_seq));
    if (baseline && contact.unread > 0 && contact.last_incoming_seq > seen) {
      void deliver(`private:${contact.id}`, contact.last_incoming_seq, { title: `私聊 · ${contact.name}`, body: contact.last_incoming, contact: contact.id });
    }
  }
  baseline = true;
}
