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
}

let state: NotifyState = { unread: 0, toast: null, soundEnabled: true };
let soundLoaded = false;
const listeners = new Set<() => void>();

function emit(next: Partial<NotifyState>) {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
}

export function subscribeChatNotify(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getChatNotifySnapshot(): NotifyState {
  if (!soundLoaded && typeof window !== "undefined") {
    soundLoaded = true;
    state = { ...state, soundEnabled: storageGet(SOUND_KEY) !== "off" };
  }
  return state;
}

const SERVER_SNAPSHOT: NotifyState = { unread: 0, toast: null, soundEnabled: true };
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
  return Number(storageGet(LAST_READ_KEY)) || 0;
}

/** 标记读到某条消息为止，并清空未读数 */
export function markChatRead(messageId: number) {
  if (messageId > getLastRead()) storageSet(LAST_READ_KEY, String(messageId));
  if (state.unread !== 0) emit({ unread: 0 });
}

export function setChatUnread(count: number) {
  if (state.unread !== count) emit({ unread: count });
}

export function addChatUnread(count: number) {
  if (count > 0) emit({ unread: state.unread + count });
}

/** 是否为别人发送的消息（自己的消息不触发提醒） */
export function isFromOthers(message: ChatRoomMessage, clientId: string): boolean {
  return !clientId || message.client_id !== clientId;
}

// ---------- 提示条 ----------

let toastTimer: number | undefined;

export function showChatToast(message: ChatRoomMessage) {
  emit({ toast: { id: message.id, nickname: message.nickname, content: message.content } });
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
