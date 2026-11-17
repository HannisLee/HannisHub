/**
 * 聊天室新消息提醒的共享状态。
 *
 * 页面切换时 AppShell 会重新挂载，因此未读数与提示条放在模块级存储中，
 * 「最后已读消息 id」与提示音开关写入 localStorage，刷新后仍可恢复。
 */

import type { ChatRoomMessage } from "./types";

const LAST_READ_KEY = "hannishub_chat_last_read";
const SOUND_KEY = "hannishub_chat_sound";
export const CHAT_CLIENT_ID_KEY = "hannishub_chat_client_id";

export interface ChatToast {
  id: number;
  nickname: string;
  content: string;
}

interface NotifyState {
  unread: number;
  toast: ChatToast | null;
  soundEnabled: boolean;
  /** 聊天室正以内嵌面板形式打开（如聊天大厅圆桌）：此时由聊天组件自己处理已读，后台检查暂停 */
  embedded: boolean;
}

let state: NotifyState = { unread: 0, toast: null, soundEnabled: true, embedded: false };
let soundLoaded = false;
const listeners = new Set<() => void>();
const unreadIds = new Set<number>();
let lastRead = 0;
let adminAlertHandler: ((messages: readonly ChatRoomMessage[]) => void) | null = null;

/** 管理员外壳接管跨页面提醒；普通账号继续使用原有提示音。 */
export function setAdminChatAlertHandler(handler: typeof adminAlertHandler) {
  adminAlertHandler = handler;
}

export function announceChatMessages(messages: readonly ChatRoomMessage[]) {
  if (adminAlertHandler) adminAlertHandler(messages);
  else playChatDing();
}

function emit(next: Partial<NotifyState>) {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
}

/** 监听其他窗口的已读进度；窗口恢复时补同步后台期间可能延迟的事件。 */
function syncChatRead() {
  const read = getLastRead();
  for (const id of unreadIds) if (id <= read) unreadIds.delete(id);
  const toast = state.toast && state.toast.id > read ? state.toast : null;
  if (toast !== state.toast) window.clearTimeout(toastTimer);
  if (state.unread !== unreadIds.size || toast !== state.toast) emit({ unread: unreadIds.size, toast });
}

function onReadStorage(event: StorageEvent) {
  if (event.key === LAST_READ_KEY || event.key === null) syncChatRead();
}

export function subscribeChatNotify(listener: () => void) {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first && typeof window !== "undefined") {
    window.addEventListener("storage", onReadStorage);
    window.addEventListener("focus", syncChatRead);
    document.addEventListener("visibilitychange", syncChatRead);
    syncChatRead();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onReadStorage);
      window.removeEventListener("focus", syncChatRead);
      document.removeEventListener("visibilitychange", syncChatRead);
    }
  };
}

export function getChatNotifySnapshot(): NotifyState {
  if (!soundLoaded && typeof window !== "undefined") {
    soundLoaded = true;
    state = { ...state, soundEnabled: storageGet(SOUND_KEY) !== "off" };
  }
  return state;
}

const SERVER_SNAPSHOT: NotifyState = { unread: 0, toast: null, soundEnabled: true, embedded: false };
export function getChatNotifyServerSnapshot(): NotifyState {
  return SERVER_SNAPSHOT;
}

function storageGet(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function storageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 浏览器禁用存储时仅在本次页面内生效
  }
}

export function readChatClientId(): string {
  return storageGet(CHAT_CLIENT_ID_KEY);
}

/** 最后已读消息 id；0 表示本浏览器从未打开过聊天室 */
export function getLastRead(): number {
  lastRead = Math.max(lastRead, Number(storageGet(LAST_READ_KEY)) || 0);
  return lastRead;
}

/** 标记读到某条消息为止，保留比该位置更新的未读消息。 */
export function markChatRead(messageId: number) {
  if (messageId > getLastRead()) {
    lastRead = messageId;
    storageSet(LAST_READ_KEY, String(messageId));
  }
  syncChatRead();
}

/** 内嵌聊天室打开 / 关闭；打开时收起已有提示条 */
export function setChatEmbedded(open: boolean) {
  if (state.embedded === open) return;
  if (open) window.clearTimeout(toastTimer);
  emit(open ? { embedded: true, toast: null } : { embedded: false });
}

export function setChatUnread(messages: readonly ChatRoomMessage[]) {
  unreadIds.clear();
  addChatUnread(messages);
}

export function addChatUnread(messages: readonly ChatRoomMessage[]) {
  const read = getLastRead();
  for (const message of messages) if (message.id > read) unreadIds.add(message.id);
  syncChatRead();
}

/** 是否为别人发送的消息（自己的消息不触发提醒） */
export function isFromOthers(message: ChatRoomMessage, clientId: string): boolean {
  return !clientId || message.client_id !== clientId;
}

// ---------- 提示条 ----------

let toastTimer: number | undefined;

/** 提示条与预览使用的消息摘要：附件显示为「[图片]」或「[文件] 名称」 */
export function messagePreview(message: ChatRoomMessage): string {
  if (message.content) return message.content;
  if (message.attachment) return message.attachment.kind === "image" ? "[图片]" : `[文件] ${message.attachment.name}`;
  return "";
}

export function showChatToast(message: ChatRoomMessage) {
  if (message.id <= getLastRead()) return;
  emit({ toast: { id: message.id, nickname: message.nickname, content: messagePreview(message) } });
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => emit({ toast: null }), 6000);
}

export function dismissChatToast() {
  window.clearTimeout(toastTimer);
  emit({ toast: null });
}

// ---------- 提示音 ----------

let audioContext: AudioContext | null = null;
let lastDingAt = 0;

export function setChatSoundEnabled(enabled: boolean) {
  storageSet(SOUND_KEY, enabled ? "on" : "off");
  emit({ soundEnabled: enabled });
}

/** 浏览器要求音频在用户交互后才能播放：首次点击或按键时创建并恢复 AudioContext */
export function unlockChatAudio() {
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === "suspended") void audioContext.resume();
  } catch {
    audioContext = null;
  }
}

/** 用 Web Audio 合成一声短促的双音「叮」，1.5 秒内最多响一次 */
export function playChatDing() {
  if (!getChatNotifySnapshot().soundEnabled) return;
  const now = Date.now();
  if (now - lastDingAt < 1500) return;
  lastDingAt = now;
  try {
    audioContext ??= new AudioContext();
    const context = audioContext;
    const start = context.currentTime;
    [880, 1320].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + index * 0.12;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.3);
    });
  } catch {
    // 浏览器不支持或尚未允许播放时静默跳过
  }
}

// ---------- 标签页图标红点 ----------

let originalFavicon: string | null = null;
let badgeShown = false;

function faviconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

/** 有未读时在标签页图标右上角画一个红点，清零后恢复原图标 */
export function updateFaviconBadge(show: boolean) {
  if (typeof document === "undefined" || show === badgeShown) return;
  const link = faviconLink();
  if (!link) return;
  originalFavicon ??= link.href;
  badgeShown = show;
  if (!show) {
    link.href = originalFavicon;
    return;
  }
  const image = new Image();
  image.onload = () => {
    if (!badgeShown) return;
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0, size, size);
    context.beginPath();
    context.arc(size - 14, 14, 13, 0, Math.PI * 2);
    context.fillStyle = "#C64545";
    context.fill();
    context.lineWidth = 4;
    context.strokeStyle = "#141413";
    context.stroke();
    link.href = canvas.toDataURL("image/png");
  };
  image.src = originalFavicon;
}
