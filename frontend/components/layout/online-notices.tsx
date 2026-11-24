"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { getAdminNotifySnapshot } from "../../lib/admin-notify";
import { canUseDesktopNotifications, showDesktopNotification } from "../../lib/desktop-notify";
import { isAdmin } from "../../lib/navigation";
import { PRIVATE_MESSAGE_EVENT, ROOM_MESSAGE_EVENT } from "../../lib/online-notice-events";
import type { AuthStatus } from "../../lib/types";
import { useRouter } from "next/navigation";

const TITLE = "HannisHub 在线广播测试";
const BODY = "管理员向当前在线的会话发送了一条测试通知。";

function showBroadcast(id: string) {
  showDesktopNotification(TITLE, {
    body: BODY,
    icon: "/icon.svg",
    tag: `hannishub-broadcast-${id}`,
    silent: true,
  }, () => {});
}

export function OnlineNotices({ username }: { username: string }) {
  const router = useRouter();
  const [notice, setNotice] = useState("");
  const [permissionStatus, setPermissionStatus] = useState("");

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const origin = process.env.NEXT_PUBLIC_HANNISHUB_WS_ORIGIN || `${protocol}//${location.host}`;

    function connect() {
      socket = new WebSocket(`${origin}/api/notifications/ws`);
      socket.onopen = () => { attempts = 0; };
      socket.onmessage = async event => {
        try {
          const { id, type, name, text } = JSON.parse(event.data);
          // 聊天事件仅触发刷新，消息内容由现有认证接口返回。
          if (type === "private-chat" || type === "chat-room") {
            window.dispatchEvent(new Event(type === "private-chat" ? PRIVATE_MESSAGE_EVENT : ROOM_MESSAGE_EVENT));
            return;
          }
          if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) return;
          // 用当前 Cookie 复验，避免已从其他标签页退出的页面继续显示通知。
          const session = await apiFetch<AuthStatus>("/api/auth/status", { cache: "no-store" });
          if (!active || !session.authenticated || session.username !== username) return;
          if (type === "lobby-say") {
            if ((!document.hidden && document.hasFocus()) || typeof name !== "string" || typeof text !== "string") return;
            if (isAdmin(username) && !getAdminNotifySnapshot().desktop) return;
            showDesktopNotification(`大厅 · ${name}`, {
              body: text,
              icon: "/icon.svg",
              tag: `hannishub-lobby-${id}`,
              silent: true,
            }, () => router.push("/chat-lobby"));
            return;
          }
          setNotice(id);
          setPermissionStatus("");
          showBroadcast(id);
          clearTimeout(expiry);
          expiry = setTimeout(() => setNotice(""), 20000);
        } catch { /* 无效消息或会话确认失败时忽略该次广播 */ }
      };
      socket.onclose = event => {
        if (active && ![4401, 4403].includes(event.code)) {
          retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000));
        }
      };
    }

    connect();
    return () => {
      active = false;
      clearTimeout(retry);
      clearTimeout(expiry);
      socket?.close();
    };
  }, [router, username]);

  async function enableDesktop() {
    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        showBroadcast(notice);
        setPermissionStatus("已允许桌面通知。");
      } else {
        setPermissionStatus(permission === "denied" ? "请在地址栏的站点设置中允许通知。" : "尚未授权桌面通知。");
      }
    } catch {
      setPermissionStatus("浏览器未能申请通知权限。");
    }
  }

  if (!notice) return null;
  return (
    <section className="chat-toast online-notice" aria-label={TITLE}>
      <div className="chat-toast-body">
        <strong className="chat-toast-title" role="status">{TITLE}</strong>
        <span>{BODY}</span>
        {canUseDesktopNotifications() && Notification.permission !== "granted" && !permissionStatus
          ? <button type="button" className="chat-toast-title" onClick={enableDesktop}>允许桌面通知</button>
          : null}
        {permissionStatus ? <span role="status">{permissionStatus}</span> : null}
      </div>
      <button type="button" className="chat-toast-close" onClick={() => setNotice("")} aria-label="关闭广播通知">×</button>
    </section>
  );
}
