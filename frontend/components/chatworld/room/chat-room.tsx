"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../../lib/api";
import {
  CHAT_CLIENT_ID_KEY,
  addChatUnread,
  getLastRead,
  isFromOthers,
  markChatRead,
  announceChatMessages,
  setChatSoundEnabled,
} from "../../../lib/chat-notify";
import { errorMessage } from "../../../lib/format";
import type { AuthStatus, ChatAttachment, ChatRoomMessage, ChatRoomMessages, ChatRoomProfile } from "../../../lib/types";
import { Icon } from "../../ui/icon";
import { Button, ErrorState, LoadingState } from "../../ui/primitives";
import { ChatAttachmentCard, ChatLightbox, INLINE_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, uploadChatAttachment, type AttachmentDisplay, type LightboxImage } from "../shared/chat-attachment";
import { Avatar, formatChatTime as formatTime } from "../shared/chat-avatar";
import { useChatNotify } from "./chat-watcher";
import { ChatEmojiPicker } from "./emoji-picker";
import { useShell } from "../../layout/shell-context";
import { ADMIN_PRIVATE_VIEW_EVENT } from "../../../lib/admin-notify";

const MESSAGES = `${API_PATHS.chatRoom}/messages`;
const PROFILE = `${API_PATHS.chatRoom}/profile`;
const FILES = `${API_PATHS.chatRoom}/files`;
const NICKNAME_KEY = "hannishub_chat_nickname";
const POLL_MS = 2000;
const SEND_TIMEOUT_MS = 15000;
/** 本地待发送消息：先显示在界面上，后台发送成功后替换为服务端消息 */
interface PendingMessage {
  nonce: string;
  content: string;
  created_at: number;
  status: "sending" | "failed";
  /** 附件：待上传的本地文件、图片预览地址、上传进度与上传后的附件信息 */
  file?: File;
  previewUrl?: string;
  progress?: number;
  attachment?: ChatAttachment;
  error?: string;
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

/** 生成随机十六进制串；使用 getRandomValues 以兼容 http 局域网访问 */
function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  window.crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
}

/** 读取或生成本浏览器的聊天室标识 */
function ensureClientId(): string {
  const saved = storageGet(CHAT_CLIENT_ID_KEY);
  if (/^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  const id = randomHex(12);
  storageSet(CHAT_CLIENT_ID_KEY, id);
  return id;
}

function fileUrl(id: string, download = false): string {
  return `${FILES}/${encodeURIComponent(id)}${download ? "?download=true" : ""}`;
}

/** 一行可渲染的消息：服务端消息或本地待发送消息 */
interface DisplayMessage {
  /** 服务端消息编号；本地待发送消息没有 */
  id?: number;
  key: string;
  senderKey: string;
  mine: boolean;
  nickname: string;
  avatar: string;
  content: string;
  created_at: number;
  /** 附件信息；本地待发送时 name/size 来自本地文件 */
  attachment?: AttachmentDisplay;
  pending?: PendingMessage;
}

/** 公共聊天室：顶部为在线人数与个人设置，中部为共享消息流，底部为输入框、附件与表情 */
export function ChatRoom({ embedded = false }: { embedded?: boolean } = {}) {
  const admin = useShell()?.admin ?? false;
  const [messages, setMessages] = useState<ChatRoomMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ChatRoomProfile>>({});
  const [online, setOnline] = useState<string[]>([]);
  const [clientId, setClientId] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"" | "settings" | "online">("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const { soundEnabled } = useChatNotify();

  const lastIdRef = useRef(0);
  const profilesVersionRef = useRef(-1);
  const readsVersionRef = useRef(-1);
  const reportedReadRef = useRef(0);
  const clientIdRef = useRef("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const initializedRef = useRef(false);
  const sendQueueRef = useRef<string[]>([]);
  const sendingRef = useRef(false);
  const pendingRef = useRef<PendingMessage[]>([]);
  const dragDepthRef = useRef(0);

  const me = profiles[clientId];

  /** 当前是否在看最新消息：页面可见且滚动在底部 */
  const isAttended = useCallback(() => !document.hidden && (!admin || (document.hasFocus() && !document.querySelector(".admin-private-dialog[open]"))), [admin]);
  const isWatching = useCallback(() => isAttended() && stickToBottomRef.current, [isAttended]);

  const updatePending = useCallback((update: (current: PendingMessage[]) => PendingMessage[]) => {
    const before = pendingRef.current;
    pendingRef.current = update(before);
    // 被移除的本地图片预览稍后释放，避免服务端图片加载出来前闪烁
    const kept = new Set(pendingRef.current.map(item => item.nonce));
    for (const item of before) {
      if (!kept.has(item.nonce) && item.previewUrl) {
        const url = item.previewUrl;
        window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    }
    setPending(pendingRef.current);
  }, []);

  /** 合并服务端消息；移除已被确认的本地消息，并对别人发来的新消息做未读与提示音处理 */
  const mergeMessages = useCallback((incoming: ChatRoomMessage[], notify: boolean) => {
    if (incoming.length === 0) return;
    const confirmed = new Set(incoming.map(item => item.nonce).filter(Boolean));
    if (confirmed.size) updatePending(current => current.filter(item => !confirmed.has(item.nonce)));
    const known = lastIdRef.current;
    const fresh = incoming.filter(item => item.id > known);
    setMessages(current => {
      const ids = new Set(current.map(item => item.id));
      return [...current, ...incoming.filter(item => !ids.has(item.id))].sort((a, b) => a.id - b.id);
    });
    lastIdRef.current = Math.max(known, ...incoming.map(item => item.id));

    const fromOthers = fresh.filter(item => item.id > getLastRead() && isFromOthers(item, clientIdRef.current));
    if (!notify || fromOthers.length === 0 || isWatching()) {
      if (isWatching()) markChatRead(lastIdRef.current);
      return;
    }
    // 不在看最新消息：计入未读、提示音，滚动在上方时显示「新消息」按钮
    addChatUnread(fromOthers);
    announceChatMessages(fromOthers);
    if (!stickToBottomRef.current) setNewBelow(count => count + fromOthers.length);
  }, [isWatching, updatePending]);

  /** 当前真正看到的最后一条服务端消息编号：页面可见时，取列表可视区域内最靠下的那条；否则为 0 */
  const visibleLastId = useCallback((): number => {
    const box = listRef.current;
    if (!box || document.visibilityState !== "visible" || !isAttended()) return 0;
    const view = box.getBoundingClientRect();
    const rows = box.querySelectorAll<HTMLElement>("[data-msg-id]");
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const rect = rows[index].getBoundingClientRect();
      if (rect.top < view.bottom - 8 && rect.bottom > view.top) return Number(rows[index].dataset.msgId) || 0;
    }
    return 0;
  }, [isAttended]);

  const fetchMessages = useCallback(async () => {
    const readUpTo = visibleLastId();
    const query = new URLSearchParams({
      after: String(lastIdRef.current),
      client_id: clientIdRef.current,
      profiles_version: String(profilesVersionRef.current),
      reads_version: String(readsVersionRef.current),
    });
    if (readUpTo > 0) query.set("read_up_to", String(readUpTo));
    const data = await apiFetch<ChatRoomMessages>(`${MESSAGES}?${query}`);
    reportedReadRef.current = Math.max(reportedReadRef.current, readUpTo);
    readsVersionRef.current = data.reads_version;
    setOnline(data.online);
    if (data.profiles) setProfiles(data.profiles);
    profilesVersionRef.current = data.profiles_version;
    // 服务端记录被清空时同步清空本地
    if (data.total === 0) setMessages([]);
    else mergeMessages(data.messages, initializedRef.current);
    return data;
  }, [mergeMessages, visibleLastId]);

  /** 可见范围内出现了更新的消息时，立即上报已读而不必等下一次轮询 */
  const syncRead = useCallback(() => {
    if (visibleLastId() > reportedReadRef.current) fetchMessages().catch(() => undefined);
  }, [fetchMessages, visibleLastId]);

  /** 登记本浏览器的资料：服务端绑定登录账号，名字与头像取自聊天大厅「我的房间」 */
  const saveProfile = useCallback(async (nickname: string, avatar: string) => {
    const saved = await apiFetch<ChatRoomProfile & { client_id: string }>(PROFILE, {
      method: "PUT",
      body: jsonBody({ client_id: clientIdRef.current, nickname, avatar }),
    });
    storageSet(NICKNAME_KEY, saved.nickname);
    setProfiles(current => ({ ...current, [saved.client_id]: { nickname: saved.nickname, avatar: saved.avatar, updated_at: saved.updated_at, linked: saved.linked } }));
    // 让下次轮询重新拉取资料表，与服务端版本对齐
    profilesVersionRef.current = -1;
    return saved;
  }, []);

  const markFailed = useCallback((nonce: string, message?: string) => {
    updatePending(current => current.map(entry => (entry.nonce === nonce ? { ...entry, status: "failed", error: message } : entry)));
  }, [updatePending]);

  /** 按顺序逐条发送队列中的消息，保证服务端顺序与入队顺序一致 */
  const processQueue = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      while (sendQueueRef.current.length) {
        const nonce = sendQueueRef.current[0];
        const item = pendingRef.current.find(entry => entry.nonce === nonce);
        if (item) {
          const controller = new AbortController();
          const timer = window.setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
          try {
            const message = await apiFetch<ChatRoomMessage>(MESSAGES, {
              method: "POST",
              body: jsonBody({ client_id: clientIdRef.current, content: item.content, nonce, attachment_id: item.attachment?.id }),
              signal: controller.signal,
            });
            mergeMessages([message], false);
            markChatRead(lastIdRef.current);
          } catch {
            markFailed(nonce);
          } finally {
            window.clearTimeout(timer);
          }
        }
        sendQueueRef.current.shift();
      }
    } finally {
      sendingRef.current = false;
    }
  }, [markFailed, mergeMessages]);

  const enqueue = useCallback((nonce: string) => {
    sendQueueRef.current.push(nonce);
    void processQueue();
  }, [processQueue]);

  /** 上传附件（显示进度），完成后作为消息排队发送 */
  const uploadPending = useCallback(async (nonce: string) => {
    const item = pendingRef.current.find(entry => entry.nonce === nonce);
    if (!item?.file) return;
    const file = item.file;
    try {
      let lastPercent = -1;
      const attachment = await uploadChatAttachment(FILES, file, item.previewUrl, percent => {
        if (percent === lastPercent) return;
        lastPercent = percent;
        updatePending(current => current.map(entry => (entry.nonce === nonce ? { ...entry, progress: percent } : entry)));
      });
      updatePending(current => current.map(entry => (entry.nonce === nonce ? { ...entry, attachment, progress: 100 } : entry)));
      enqueue(nonce);
    } catch (value) {
      markFailed(nonce, errorMessage(value));
    }
  }, [enqueue, markFailed, updatePending]);

  useEffect(() => {
    void (async () => {
      const id = ensureClientId();
      clientIdRef.current = id;
      setClientId(id);
      try {
        const data = await fetchMessages();
        initializedRef.current = true;
        if (!admin || isAttended()) markChatRead(lastIdRef.current);
        // 首次进入或尚未绑定账号时登记资料：名字与头像由服务端按登录账号取自「我的房间」
        if (!data.profiles?.[id]?.linked) {
          let nickname = storageGet(NICKNAME_KEY);
          if (!nickname) {
            const auth = await apiFetch<AuthStatus>("/api/auth/status").catch(() => null);
            nickname = auth?.username || "访客";
          }
          await saveProfile(nickname, "");
        }
        setError("");
      } catch (value) {
        setError(errorMessage(value));
      } finally {
        setLoading(false);
      }
    })();
    const timer = window.setInterval(() => {
      // 页面隐藏时也继续轮询，以便计入未读并播放提示音
      fetchMessages().then(() => setError("")).catch(value => setError(errorMessage(value)));
    }, POLL_MS);
    // 回到页面且停在底部时，视为已读
    const onVisible = () => {
      if (isWatching() && (!admin || listRef.current?.isConnected)) markChatRead(lastIdRef.current);
      if (isAttended()) syncRead();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (admin) {
      window.addEventListener("focus", onVisible);
      window.addEventListener(ADMIN_PRIVATE_VIEW_EVENT, onVisible);
    }
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      if (admin) {
        window.removeEventListener("focus", onVisible);
        window.removeEventListener(ADMIN_PRIVATE_VIEW_EVENT, onVisible);
      }
    };
  }, [admin, fetchMessages, isAttended, isWatching, saveProfile, syncRead]);

  // 停留在底部时，新消息（含本地待发送消息）自动滚动到底
  useEffect(() => {
    const box = listRef.current;
    if (box && stickToBottomRef.current) box.scrollTop = box.scrollHeight;
  }, [messages, pending]);

  // 新消息渲染并滚动到位后，上报当前看到的位置作为已读
  useEffect(() => {
    syncRead();
  }, [messages, loading, syncRead]);

  // 输入框随内容自动增高（上限由 CSS max-height 控制）
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  }, [draft]);

  // 点击表情面板外部或按 Esc 时关闭
  useEffect(() => {
    if (!emojiOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (emojiRef.current && !emojiRef.current.contains(event.target as Node)) setEmojiOpen(false);
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setEmojiOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [emojiOpen]);

  function onScroll() {
    const box = listRef.current;
    if (!box) return;
    stickToBottomRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (stickToBottomRef.current) {
      setNewBelow(0);
      if (isAttended()) markChatRead(lastIdRef.current);
    }
    syncRead();
  }

  function jumpToLatest() {
    const box = listRef.current;
    stickToBottomRef.current = true;
    setNewBelow(0);
    markChatRead(lastIdRef.current);
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }

  function togglePanel(next: "settings" | "online") {
    setPanel(current => (current === next ? "" : next));
  }

  function insertEmoji(emoji: string) {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    // 插入后把光标放到表情之后
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  /** 乐观发送文字：立即显示在界面上并清空输入框，后台排队发送 */
  function send() {
    const content = draft.trim();
    if (!content || !clientId) return;
    const nonce = randomHex(12);
    updatePending(current => [...current, { nonce, content, created_at: Date.now() / 1000, status: "sending" }]);
    setDraft("");
    setEmojiOpen(false);
    stickToBottomRef.current = true;
    setNewBelow(0);
    enqueue(nonce);
  }

  /** 发送图片或文件：每个文件一条消息，立即显示并后台上传 */
  function sendFiles(list: File[]) {
    if (!clientId || list.length === 0) return;
    const problems: string[] = [];
    for (const file of list) {
      if (file.size === 0) {
        problems.push(`「${file.name}」是空文件或文件夹`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problems.push(`「${file.name}」超过 ${MAX_ATTACHMENT_MB} MB`);
        continue;
      }
      const nonce = randomHex(12);
      const previewUrl = INLINE_IMAGE_TYPES.has(file.type) ? URL.createObjectURL(file) : undefined;
      updatePending(current => [...current, { nonce, content: "", created_at: Date.now() / 1000, status: "sending", file, previewUrl, progress: 0 }]);
      void uploadPending(nonce);
    }
    setError(problems.length ? `${problems.join("，")}，未发送` : "");
    stickToBottomRef.current = true;
    setNewBelow(0);
  }

  function retry(nonce: string) {
    const item = pendingRef.current.find(entry => entry.nonce === nonce);
    if (!item) return;
    updatePending(current => current.map(entry => (entry.nonce === nonce ? { ...entry, status: "sending", error: undefined } : entry)));
    // 附件尚未上传成功时重新上传，否则只重发消息
    if (item.file && !item.attachment) void uploadPending(nonce);
    else enqueue(nonce);
  }

  function discard(nonce: string) {
    updatePending(current => current.filter(entry => entry.nonce !== nonce));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  /** 粘贴剪贴板中的图片或文件时直接发送 */
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    sendFiles(files);
  }

  function onPickFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    sendFiles(files);
  }

  // 拖拽：用计数器处理子元素之间移动时的 dragenter/dragleave 抖动
  function hasFiles(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function onDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    sendFiles(Array.from(event.dataTransfer.files));
  }

  const display: DisplayMessage[] = [
    ...messages.map(message => {
      const profile = message.client_id ? profiles[message.client_id] : undefined;
      const attachment = message.attachment;
      return {
        id: message.id,
        key: `m-${message.id}`,
        senderKey: message.client_id ?? message.nickname,
        mine: message.client_id ? message.client_id === clientId : !!me && message.nickname === me.nickname,
        nickname: profile?.nickname ?? message.nickname,
        avatar: profile?.avatar ?? "",
        content: message.content,
        created_at: message.created_at,
        attachment: attachment ? { ...attachment, src: attachment.kind === "image" ? fileUrl(attachment.id) : undefined } : undefined,
      };
    }),
    ...pending.map(item => ({
      key: `p-${item.nonce}`,
      senderKey: clientId,
      mine: true,
      nickname: me?.nickname ?? "",
      avatar: me?.avatar ?? "",
      content: item.content,
      created_at: item.created_at,
      attachment: item.file
        ? {
          id: item.attachment?.id,
          name: item.file.name,
          size: item.file.size,
          kind: item.previewUrl ? "image" as const : "file" as const,
          width: item.attachment?.width,
          height: item.attachment?.height,
          src: item.previewUrl,
        }
        : undefined,
      pending: item,
    })),
  ];


  return (
    <section
      className={`chat-main${dragging ? " chat-main-dragging" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="chat-main-head">
        <h2 className="chat-main-title">聊天室</h2>
        <div className="chat-toolbar">
          <button type="button" className={`chat-toolbar-button${panel === "online" ? " chat-toolbar-active" : ""}`} onClick={() => togglePanel("online")}>
            <span className="status-dot" />{online.length} 人在线
          </button>
          <button type="button" className={`chat-toolbar-button${panel === "settings" ? " chat-toolbar-active" : ""}`} onClick={() => togglePanel("settings")} aria-label="聊天设置">
            <Avatar nickname={me?.nickname ?? ""} avatar={me?.avatar} size="sm" />
            <span>{me?.nickname ?? "设置"}</span>
          </button>
        </div>
      </header>

      {panel === "online" ? (
        <div className="chat-panel">
          <p className="chat-panel-title">当前在线</p>
          <div className="chat-online-list">
            {online.map(id => {
              const profile = profiles[id];
              const name = profile?.nickname ?? "未命名";
              return (
                <span key={id} className="chat-online-item">
                  <Avatar nickname={name} avatar={profile?.avatar} size="sm" />
                  {name}{id === clientId ? <span className="muted-line">（我）</span> : null}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      {panel === "settings" ? (
        <div className="chat-panel chat-settings">
          <Avatar nickname={me?.nickname ?? ""} avatar={me?.avatar} size="lg" />
          <div className="chat-settings-fields">
            <div className="field">
              <span className="field-label">名字与头像</span>
              <strong className="chat-settings-name">{me?.nickname ?? "未命名"}</strong>
              <span className="field-hint">
                聊天室和私聊的名字、头像以聊天大厅「我的房间」衣柜前的设置为准
                {embedded ? "，回到大厅后在房间里修改。" : <>，<Link href="/chat-lobby">前往聊天大厅修改</Link>。</>}
              </span>
            </div>
            <label className="check-choice">
              <input type="checkbox" checked={soundEnabled} onChange={event => setChatSoundEnabled(event.target.checked)} />
              新消息提示音
              <span className="muted-line">（仅对本浏览器生效，立即保存）</span>
            </label>
            <div className="form-actions">
              <Button size="sm" variant="quiet" onClick={() => setPanel("")}>关闭</Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="chat-messages-wrap">
        <div className="chat-messages" ref={listRef} onScroll={onScroll}>
          {loading ? <LoadingState label="正在读取聊天记录…" /> : null}
          {display.map((message, index) => {
            const previous = display[index - 1];
            const grouped = !!previous && previous.senderKey === message.senderKey && message.created_at - previous.created_at < 300;
            const status = message.pending?.status;
            return (
              <div key={message.key} data-msg-id={message.id} className={`chat-row${message.mine ? " chat-row-mine" : ""}${grouped ? " chat-row-grouped" : ""}`}>
                {grouped ? <span className="chat-avatar-spacer" /> : <Avatar nickname={message.nickname} avatar={message.avatar} />}
                <div className={`chat-message${status === "sending" ? " chat-message-sending" : ""}${status === "failed" ? " chat-message-failed" : ""}`}>
                  {grouped ? null : <span className="chat-message-meta"><strong>{message.nickname}</strong> · {formatTime(message.created_at)}</span>}
                  {message.attachment ? <ChatAttachmentCard attachment={message.attachment}
                    downloadHref={message.attachment.id ? fileUrl(message.attachment.id, true) : undefined}
                    progress={message.pending?.status === "sending" && !message.pending.attachment ? message.pending.progress ?? 0 : undefined}
                    onOpen={setLightbox} /> : null}
                  {message.content ? <div className="chat-bubble">{message.content}</div> : null}
                  {status === "failed" && message.pending ? (
                    <span className="chat-send-failed">
                      {message.pending.error ? `发送失败：${message.pending.error}` : "发送失败"}
                      <button type="button" onClick={() => retry(message.pending!.nonce)}>重试</button>
                      <button type="button" onClick={() => discard(message.pending!.nonce)}>删除</button>
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {newBelow > 0 ? (
          <button type="button" className="chat-new-below" onClick={jumpToLatest}>↓ {newBelow} 条新消息</button>
        ) : null}
        {dragging ? <div className="chat-drop-hint">松开即可发送图片或文件（单个不超过 {MAX_ATTACHMENT_MB} MB）</div> : null}
      </div>

      {error ? <ErrorState message={error} /> : null}

      <div className="chat-composer">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="输入消息，Enter 发送；可拖入或粘贴图片和文件"
          rows={1}
        />
        <input ref={fileInputRef} type="file" multiple hidden onChange={onPickFiles} />
        <button type="button" className="chat-emoji-toggle" onClick={() => fileInputRef.current?.click()} aria-label="发送图片或文件" title={`发送图片或文件（不超过 ${MAX_ATTACHMENT_MB} MB）`}>
          <Icon name="attach" />
        </button>
        <div className="chat-emoji-anchor" ref={emojiRef}>
          <button type="button" className={`chat-emoji-toggle${emojiOpen ? " chat-toolbar-active" : ""}`} onClick={() => setEmojiOpen(open => !open)} aria-label="表情" aria-expanded={emojiOpen}>
            <Icon name="smile" />
          </button>
          {emojiOpen ? <div className="chat-emoji-popover"><ChatEmojiPicker onSelect={insertEmoji} /></div> : null}
        </div>
        <Button onClick={send} disabled={!draft.trim() || !clientId}>发送</Button>
      </div>

      {lightbox ? <ChatLightbox lightbox={lightbox} onClose={closeLightbox} /> : null}
    </section>
  );
}
