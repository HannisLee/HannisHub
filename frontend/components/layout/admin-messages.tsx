"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { lobbySocketUrl } from "../../lib/chat-lobby";
import { setAdminChatAlertHandler, setChatSoundEnabled, unlockChatAudio } from "../../lib/chat-notify";
import {
  ADMIN_OPEN_CHAT_EVENT, ADMIN_PRIVATE_VIEW_EVENT, adminRoomAlert, canUseDesktopNotifications, dismissAdminToast,
  getAdminNotifyServerSnapshot, getAdminNotifySnapshot, openAdminAlert, openAdminPrivate,
  requestAdminDesktopPermission, setAdminDesktop, setViewedPrivate, subscribeAdminNotify, updateAdminContacts, type AdminContact,
} from "../../lib/admin-notify";
import { useChatNotify } from "../chatworld/room/chat-watcher";
import { Button } from "../ui/primitives";

const PrivatePanel = dynamic(() => import("../chatworld/lobby/private-panel").then(module => module.PrivatePanel), { ssr: false });
const PRIVATE_EVENT = "lobby-private-chat";

export function useAdminMessages(enabled: boolean, onLobby: boolean, admin: boolean) {
  const router = useRouter();
  const state = useSyncExternalStore(subscribeAdminNotify, getAdminNotifySnapshot, getAdminNotifyServerSnapshot);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let running = false;
    let queued = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    async function refresh() {
      if (running) { queued = true; return; }
      running = true;
      try {
        const contacts = await apiFetch<AdminContact[]>("/api/chat-lobby/private-chat/contacts");
        if (alive) updateAdminContacts(contacts, admin);
      } catch { /* 重连与下一轮轮询会补齐未读 */ }
      finally { running = false; if (queued && alive) { queued = false; void refresh(); } }
    }
    const activity = () => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "background", active: !onLobby && !document.hidden && document.hasFocus() }));
    };
    const openChat = () => router.push("/chat");
    const viewPrivate = (event: Event) => setViewedPrivate((event as CustomEvent<string | null>).detail);
    const update = () => { activity(); void refresh(); };
    const syncPreferences = (event: StorageEvent) => {
      if (event.key === "hannishub_admin_desktop_notify") setAdminDesktop(event.newValue === "on");
      if (event.key === "hannishub_chat_sound") setChatSoundEnabled(event.newValue !== "off");
    };
    const connect = () => {
      if (!alive) return;
      socket = new WebSocket(`${lobbySocketUrl()}?background=1`);
      socket.onopen = () => { attempts = 0; activity(); void refresh(); };
      socket.onmessage = event => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "private-chat") window.dispatchEvent(new Event(PRIVATE_EVENT));
          else if (data.type === "desks") activity();
        } catch { /* 忽略无效帧 */ }
      };
      socket.onclose = event => {
        if (alive && ![4401, 4403].includes(event.code)) retry = setTimeout(connect, Math.min(10000, 1000 * 2 ** attempts++));
      };
    };
    if (admin) setAdminChatAlertHandler(adminRoomAlert);
    window.addEventListener(PRIVATE_EVENT, update);
    window.addEventListener(ADMIN_OPEN_CHAT_EVENT, openChat);
    window.addEventListener(ADMIN_PRIVATE_VIEW_EVENT, viewPrivate);
    window.addEventListener("focus", update);
    window.addEventListener("blur", activity);
    window.addEventListener("storage", syncPreferences);
    document.addEventListener("visibilitychange", update);
    const initial = setTimeout(() => { if (admin) connect(); void refresh(); }, 0);
    const polling = setInterval(() => { void refresh(); }, 4000);
    const heartbeat = setInterval(activity, 8000);
    return () => {
      alive = false;
      setAdminChatAlertHandler(null);
      setViewedPrivate(null);
      clearTimeout(initial); clearTimeout(retry); clearInterval(polling); clearInterval(heartbeat);
      socket?.close();
      window.removeEventListener(PRIVATE_EVENT, update);
      window.removeEventListener(ADMIN_OPEN_CHAT_EVENT, openChat);
      window.removeEventListener(ADMIN_PRIVATE_VIEW_EVENT, viewPrivate);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", activity);
      window.removeEventListener("storage", syncPreferences);
      document.removeEventListener("visibilitychange", update);
    };
  }, [enabled, onLobby, router, admin]);
  return state;
}

export function AdminMessageControls() {
  const state = useSyncExternalStore(subscribeAdminNotify, getAdminNotifySnapshot, getAdminNotifyServerSnapshot);
  const { soundEnabled } = useChatNotify();
  const [settings, setSettings] = useState(false);
  const [status, setStatus] = useState("");
  const available = canUseDesktopNotifications();
  const requestDesktop = async () => {
    unlockChatAudio();
    if (!available) return;
    try {
      const permission = await requestAdminDesktopPermission();
      setStatus(permission === "granted" ? "已开启。切到其他标签页或应用后，新消息会显示系统通知。" : permission === "denied" ? "浏览器已阻止通知，可在地址栏的站点设置中允许。" : "尚未授权，标签页、提示音与网页提醒仍然可用。");
    } catch { setStatus("当前浏览器无法申请系统通知，其他提醒仍然可用。"); }
  };
  return <div className="admin-message-controls">
    <Button variant="quiet" size="sm" onClick={() => openAdminPrivate(state.latest || "")} aria-label={`管理员私聊${state.unread ? `，${state.unread} 条未读` : ""}`}>
      私聊{state.unread ? <span className="nav-badge">{state.unread > 99 ? "99+" : state.unread}</span> : null}
    </Button>
    <Button variant="quiet" size="sm" aria-expanded={settings} aria-label="消息提醒设置" onClick={() => setSettings(value => !value)}>提醒</Button>
    {settings ? <section className="admin-message-settings" aria-label="消息提醒设置">
      <strong>消息提醒</strong>
      <label><span>新消息提示音</span><input type="checkbox" checked={soundEnabled} onChange={event => { unlockChatAudio(); setChatSoundEnabled(event.target.checked); }} /></label>
      <label><span>桌面通知</span><input type="checkbox" checked={state.desktop} onChange={event => { if (event.target.checked) void requestDesktop(); else setAdminDesktop(false); }} disabled={!available} /></label>
      {!state.desktop ? <Button variant="secondary" size="sm" onClick={() => void requestDesktop()} disabled={!available}>开启桌面通知</Button> : null}
      <p>{!available ? "桌面通知需要 HTTPS 或 localhost，以及支持通知的浏览器。当前仍会显示标签页未读和网页提醒。" : status || "点击开启后，在浏览器弹窗中选择允许。切到别的标签页或应用后，仍可收到新私聊和聊天室消息。"}</p>
      <Button variant="quiet" size="sm" onClick={() => setSettings(false)}>收起</Button>
    </section> : null}
  </div>;
}

function PrivateDialog({ contact }: { contact: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const close = () => openAdminPrivate(null);
  return <dialog ref={ref} className="lobby-machine is-compact admin-private-dialog" aria-label="管理员私聊" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="lobby-machine-bar"><strong>私聊</strong><Button variant="quiet" size="sm" onClick={close} aria-label="关闭私聊">关闭 · Esc</Button></header>
    <div className="lobby-machine-body is-fill"><PrivatePanel mode="inbox" contactId={contact} onClose={close} /></div>
  </dialog>;
}

export function AdminMessageOverlays() {
  const state = useSyncExternalStore(subscribeAdminNotify, getAdminNotifySnapshot, getAdminNotifyServerSnapshot);
  return <>
    {state.toast ? <div className="chat-toast" role="status">
      <button type="button" className="chat-toast-body admin-message-toast" onClick={() => state.toast && openAdminAlert(state.toast)}><span className="chat-toast-title">{state.toast.title}</span><span className="chat-toast-content">{state.toast.body}</span></button>
      <button type="button" className="chat-toast-close" onClick={dismissAdminToast} aria-label="关闭提醒">×</button>
    </div> : null}
    {state.contact !== null ? <PrivateDialog key={state.contact} contact={state.contact} /> : null}
  </>;
}
