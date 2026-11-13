"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { API_PATHS, apiFetch } from "../../../lib/api";
import {
  addChatUnread,
  dismissChatToast,
  getChatNotifyServerSnapshot,
  getChatNotifySnapshot,
  getLastRead,
  isFromOthers,
  markChatRead,
  playChatDing,
  readChatClientId,
  setChatUnread,
  showChatToast,
  subscribeChatNotify,
  unlockChatAudio,
  updateFaviconBadge,
} from "../../../lib/chat-notify";
import type { ChatRoomMessages } from "../../../lib/types";

const MESSAGES = `${API_PATHS.chatRoom}/messages`;
const WATCH_MS = 4000;

export function useChatNotify() {
  return useSyncExternalStore(subscribeChatNotify, getChatNotifySnapshot, getChatNotifyServerSnapshot);
}

/**
 * 不在聊天室页面时后台检查新消息：更新未读数，并对新到达的消息弹出提示条、播放提示音。
 * 不携带 client_id，因此不会被计入在线人数。
 */
export function useChatWatcher(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let lastSeen = 0;

    async function initialize() {
      const lastRead = getLastRead();
      if (lastRead === 0) {
        // 从未打开过聊天室：以当前最新消息为起点，不把历史记录算作未读
        const latest = await apiFetch<ChatRoomMessages>(`${MESSAGES}?limit=1`);
        const latestId = latest.messages.at(-1)?.id ?? 0;
        markChatRead(latestId);
        lastSeen = latestId;
        return;
      }
      const data = await apiFetch<ChatRoomMessages>(`${MESSAGES}?after=${lastRead}&limit=500`);
      const clientId = readChatClientId();
      setChatUnread(data.messages.filter(message => isFromOthers(message, clientId)).length);
      lastSeen = data.messages.at(-1)?.id ?? lastRead;
    }

    async function check() {
      const data = await apiFetch<ChatRoomMessages>(`${MESSAGES}?after=${lastSeen}&limit=100`);
      if (cancelled || data.messages.length === 0) return;
      lastSeen = data.messages.at(-1)?.id ?? lastSeen;
      const clientId = readChatClientId();
      const fresh = data.messages.filter(message => isFromOthers(message, clientId));
      if (fresh.length === 0) return;
      addChatUnread(fresh.length);
      showChatToast(fresh[fresh.length - 1]);
      playChatDing();
    }

    let timer: number | undefined;
    const loop = async () => {
      try {
        await check();
      } catch {
        // 网络抖动时静默跳过，下一轮重试
      }
      if (!cancelled) timer = window.setTimeout(loop, WATCH_MS);
    };
    initialize()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) timer = window.setTimeout(loop, WATCH_MS);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled]);
}

/** 首次交互时解锁音频；同步标签页图标红点 */
export function useChatNotifyEffects(unread: number) {
  useEffect(() => {
    const unlock = () => unlockChatAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    updateFaviconBadge(unread > 0);
  }, [unread]);
}

/** 右下角新消息提示条，点击进入聊天室 */
export function ChatToastView() {
  const { toast } = useChatNotify();
  if (!toast) return null;
  return (
    <div className="chat-toast" role="status">
      <Link href="/chat" className="chat-toast-body" onClick={dismissChatToast}>
        <span className="chat-toast-title">{toast.nickname}</span>
        <span className="chat-toast-content">{toast.content}</span>
      </Link>
      <button type="button" className="chat-toast-close" onClick={dismissChatToast} aria-label="关闭提醒">×</button>
    </div>
  );
}
