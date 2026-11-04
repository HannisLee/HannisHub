"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { API_PATHS, apiFetch, jsonBody, uploadBinary } from "../../lib/api";
import {
  CHAT_CLIENT_ID_KEY,
  addChatUnread,
  isFromOthers,
  markChatRead,
  playChatDing,
  setChatSoundEnabled,
} from "../../lib/chat-notify";
import { errorMessage, formatBytes } from "../../lib/format";
import type { AuthStatus, ChatAttachment, ChatReceipt, ChatRoomMessage, ChatRoomMessages, ChatRoomProfile } from "../../lib/types";
import { Icon } from "../ui/icon";
import { Button, ErrorState, LoadingState } from "../ui/primitives";
import { useChatNotify } from "./chat-watcher";
import { ChatEmojiPicker } from "./emoji-picker";

const MESSAGES = `${API_PATHS.chatRoom}/messages`;
const PROFILE = `${API_PATHS.chatRoom}/profile`;
const FILES = `${API_PATHS.chatRoom}/files`;
const NICKNAME_KEY = "hannishub_chat_nickname";
const POLL_MS = 2000;
const SEND_TIMEOUT_MS = 15000;
const AVATAR_SIZE = 96;
const MAX_ATTACHMENT_MB = 50;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;
/** 与后端一致：只有这些位图在页面内显示，其余按文件发送 */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PRESET_AVATARS = ["🐱", "🐶", "🦊", "🐼", "🐸", "🐧", "🦄", "🐙", "🐳", "🌵", "🍀", "🌙"];

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

function formatTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function fileUrl(id: string, download = false): string {
  return `${FILES}/${encodeURIComponent(id)}${download ? "?download=true" : ""}`;
}

/** 读取本地图片尺寸，用于预留显示空间，避免图片加载后页面跳动 */
function readImageSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** 把用户选择的图片居中裁剪并压缩成 96×96 的 JPEG data URL */
function resizeAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const side = Math.min(image.width, image.height);
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const context = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!context) {
        reject(new Error("浏览器不支持图片处理"));
        return;
      }
      context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取该图片"));
    };
    image.src = url;
  });
}

function Avatar({ nickname, avatar, size = "md" }: { nickname: string; avatar?: string; size?: "sm" | "md" | "lg" }) {
  const className = `chat-avatar chat-avatar-${size}`;
  if (avatar?.startsWith("data:")) {
    // eslint-disable-next-line @next/next/no-img-element -- data URL 头像无需经过图片优化
    return <img className={className} src={avatar} alt="" />;
  }
  return <span className={className} aria-hidden="true">{avatar || (Array.from(nickname.trim())[0] ?? "?").toUpperCase()}</span>;
}

/** 已读状态图标：全部已读为带勾的实心圆，否则为按已读比例填充的饼图 */
function ReadPie({ read, total }: { read: number; total: number }) {
  if (total > 0 && read >= total) {
    return (
      <svg className="chat-receipt-pie chat-receipt-done" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" />
        <path d="M4.8 8.2 7 10.4 11.2 5.8" />
      </svg>
    );
  }
  const ratio = total > 0 ? read / total : 0;
  const angle = ratio * Math.PI * 2;
  const x = 8 + 4.5 * Math.sin(angle);
  const y = 8 - 4.5 * Math.cos(angle);
  return (
    <svg className="chat-receipt-pie" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="chat-receipt-ring" cx="8" cy="8" r="6.5" />
      {ratio > 0 ? <path className="chat-receipt-fill" d={`M8 8 L8 3.5 A4.5 4.5 0 ${ratio > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`} /> : null}
    </svg>
  );
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
  attachment?: { id?: string; name: string; size: number; kind: "image" | "file"; width?: number; height?: number; src?: string };
  pending?: PendingMessage;
}

/** 按图片原始比例计算缩略图尺寸，最大 320×280 */
function thumbnailStyle(width?: number, height?: number) {
  if (!width || !height) return undefined;
  const scale = Math.min(1, 320 / width, 280 / height);
  return { width: Math.round(width * scale), aspectRatio: `${width} / ${height}` };
}

/** 公共聊天室：顶部为在线人数与个人设置，中部为共享消息流，底部为输入框、附件与表情 */
export function ChatRoom() {
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
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [avatarDraft, setAvatarDraft] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNote, setProfileNote] = useState("");
  const [newBelow, setNewBelow] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; name: string; download?: string } | null>(null);
  const [receipts, setReceipts] = useState<Record<string, ChatReceipt>>({});
  const [receiptOpen, setReceiptOpen] = useState<number | null>(null);
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
  const isWatching = useCallback(() => !document.hidden && stickToBottomRef.current, []);

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

    const fromOthers = fresh.filter(item => isFromOthers(item, clientIdRef.current));
    if (!notify || fromOthers.length === 0 || isWatching()) {
      if (isWatching()) markChatRead(lastIdRef.current);
      return;
    }
    // 不在看最新消息：计入未读、提示音，滚动在上方时显示「新消息」按钮
    addChatUnread(fromOthers.length);
    playChatDing();
    if (!stickToBottomRef.current) setNewBelow(count => count + fromOthers.length);
  }, [isWatching, updatePending]);

  /** 当前真正看到的最后一条服务端消息编号：页面可见时，取列表可视区域内最靠下的那条；否则为 0 */
  const visibleLastId = useCallback((): number => {
    const box = listRef.current;
    if (!box || document.visibilityState !== "visible") return 0;
    const view = box.getBoundingClientRect();
    const rows = box.querySelectorAll<HTMLElement>("[data-msg-id]");
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const rect = rows[index].getBoundingClientRect();
      if (rect.top < view.bottom - 8 && rect.bottom > view.top) return Number(rows[index].dataset.msgId) || 0;
    }
    return 0;
  }, []);

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
    if (data.receipts) setReceipts(data.receipts);
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

  const saveProfile = useCallback(async (nickname: string, avatar: string) => {
    const saved = await apiFetch<ChatRoomProfile & { client_id: string }>(PROFILE, {
      method: "PUT",
      body: jsonBody({ client_id: clientIdRef.current, nickname, avatar }),
    });
    storageSet(NICKNAME_KEY, saved.nickname);
    setProfiles(current => ({ ...current, [saved.client_id]: { nickname: saved.nickname, avatar: saved.avatar, updated_at: saved.updated_at } }));
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
      const headers: Record<string, string> = {
        "Content-Type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      };
      const size = item.previewUrl ? await readImageSize(item.previewUrl) : null;
      if (size) {
        headers["x-image-width"] = String(size.width);
        headers["x-image-height"] = String(size.height);
      }
      let lastPercent = -1;
      const attachment = await uploadBinary<ChatAttachment>(FILES, file, headers, percent => {
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
        markChatRead(lastIdRef.current);
        // 首次进入时自动建立资料：优先沿用本地昵称，否则使用登录账号名
        if (!data.profiles?.[id]) {
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
      if (!document.hidden && stickToBottomRef.current) markChatRead(lastIdRef.current);
      if (!document.hidden) syncRead();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchMessages, saveProfile, syncRead]);

  // 停留在底部时，新消息（含本地待发送消息）自动滚动到底
  useEffect(() => {
    const box = listRef.current;
    if (box && stickToBottomRef.current) box.scrollTop = box.scrollHeight;
  }, [messages, pending]);

  // 新消息渲染并滚动到位后，上报当前看到的位置作为已读
  useEffect(() => {
    syncRead();
  }, [messages, loading, syncRead]);

  // 已读详情按 Esc 关闭
  useEffect(() => {
    if (receiptOpen === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setReceiptOpen(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [receiptOpen]);

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
      if (event.key === "Escape") setEmojiOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [emojiOpen]);

  // 大图预览按 Esc 关闭
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setLightbox(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  function onScroll() {
    const box = listRef.current;
    if (!box) return;
    stickToBottomRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (stickToBottomRef.current) {
      setNewBelow(0);
      if (!document.hidden) markChatRead(lastIdRef.current);
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
    if (next === "settings" && panel !== "settings") {
      setNicknameDraft(me?.nickname ?? "");
      setAvatarDraft(me?.avatar ?? "");
      setProfileNote("");
    }
    setPanel(current => (current === next ? "" : next));
  }

  async function submitProfile() {
    if (!nicknameDraft.trim()) {
      setProfileNote("昵称不能为空");
      return;
    }
    setSavingProfile(true);
    try {
      await saveProfile(nicknameDraft, avatarDraft);
      setPanel("");
    } catch (value) {
      setProfileNote(errorMessage(value));
    } finally {
      setSavingProfile(false);
    }
  }

  async function onAvatarFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setAvatarDraft(await resizeAvatar(file));
      setProfileNote("");
    } catch (value) {
      setProfileNote(errorMessage(value));
    }
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

  function renderAttachment(message: DisplayMessage) {
    const attachment = message.attachment;
    if (!attachment) return null;
    const uploading = message.pending?.status === "sending" && !message.pending.attachment;
    const progress = message.pending?.progress ?? 0;
    const downloadHref = attachment.id ? fileUrl(attachment.id, true) : undefined;
    const download = downloadHref ? (
      <a className="chat-attachment-download" href={downloadHref} download={attachment.name} title="下载" aria-label={`下载 ${attachment.name}`}>
        <Icon name="download" />
      </a>
    ) : null;

    if (attachment.kind === "image" && attachment.src) {
      const src = attachment.src;
      return (
        <div className="chat-image" style={thumbnailStyle(attachment.width, attachment.height)}>
          <button type="button" className="chat-image-open" onClick={() => setLightbox({ src, name: attachment.name, download: downloadHref })} aria-label={`查看 ${attachment.name}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 聊天附件为受保护的动态地址 */}
            <img src={src} alt={attachment.name} loading="lazy" />
          </button>
          {uploading ? <span className="chat-upload-overlay">{progress}%</span> : download}
        </div>
      );
    }
    return (
      <div className="chat-file">
        <span className="chat-file-icon"><Icon name="file" /></span>
        <span className="chat-file-info">
          <span className="chat-file-name" title={attachment.name}>{attachment.name}</span>
          <span className="chat-file-size">{uploading ? `上传中 ${progress}% · ` : ""}{formatBytes(attachment.size)}</span>
          {uploading ? <span className="chat-file-progress"><span style={{ width: `${progress}%` }} /></span> : null}
        </span>
        {download}
      </div>
    );
  }

  /** 自己消息下方的已读状态：饼图 + 文字，点击查看已读/未读名单 */
  function renderReceipt(id: number) {
    const receipt = receipts[String(id)];
    const total = receipt.read.length + receipt.unread.length;
    if (total === 0) return null;
    const label = receipt.unread.length === 0 ? "全部已读" : `${receipt.unread.length} 人未读`;
    return (
      <button type="button" className={`chat-receipt${receipt.unread.length === 0 ? " chat-receipt-all" : ""}`} onClick={() => setReceiptOpen(id)} title={`${receipt.read.length}/${total} 人已读，点击查看详情`}>
        <ReadPie read={receipt.read.length} total={total} />
        {label}
      </button>
    );
  }

  const openReceipt = receiptOpen !== null ? receipts[String(receiptOpen)] : undefined;

  function renderReceiptMembers(ids: string[]) {
    if (ids.length === 0) return <p className="muted-line">无</p>;
    return (
      <div className="chat-receipt-members">
        {ids.map(id => {
          const profile = profiles[id];
          const name = profile?.nickname ?? "未命名";
          return (
            <span key={id} className="chat-online-item">
              <Avatar nickname={name} avatar={profile?.avatar} size="sm" />
              {name}
            </span>
          );
        })}
      </div>
    );
  }

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
          <Avatar nickname={nicknameDraft} avatar={avatarDraft} size="lg" />
          <div className="chat-settings-fields">
            <label className="field">
              <span className="field-label">昵称</span>
              <input value={nicknameDraft} onChange={event => setNicknameDraft(event.target.value)} maxLength={24} />
            </label>
            <div className="field">
              <span className="field-label">头像</span>
              <div className="chat-avatar-options">
                <button type="button" className={`chat-avatar-option${avatarDraft === "" ? " chat-avatar-option-active" : ""}`} onClick={() => setAvatarDraft("")} title="默认（昵称首字）">
                  <Avatar nickname={nicknameDraft} size="sm" />
                </button>
                {PRESET_AVATARS.map(item => (
                  <button key={item} type="button" className={`chat-avatar-option${avatarDraft === item ? " chat-avatar-option-active" : ""}`} onClick={() => setAvatarDraft(item)}>
                    <Avatar nickname="" avatar={item} size="sm" />
                  </button>
                ))}
                <label className="button button-secondary button-sm chat-avatar-upload">
                  上传图片
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void onAvatarFile(event)} />
                </label>
              </div>
            </div>
            <label className="check-choice">
              <input type="checkbox" checked={soundEnabled} onChange={event => setChatSoundEnabled(event.target.checked)} />
              新消息提示音
              <span className="muted-line">（仅对本浏览器生效，立即保存）</span>
            </label>
            {profileNote ? <p className="error-text">{profileNote}</p> : null}
            <div className="form-actions">
              <Button size="sm" onClick={() => void submitProfile()} disabled={savingProfile}>保存</Button>
              <Button size="sm" variant="quiet" onClick={() => setPanel("")}>取消</Button>
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
                  {renderAttachment(message)}
                  {message.content ? <div className="chat-bubble">{message.content}</div> : null}
                  {message.mine && message.id !== undefined && receipts[String(message.id)] ? renderReceipt(message.id) : null}
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

      {receiptOpen !== null ? (
        <div className="chat-lightbox" role="dialog" aria-label="消息已读情况" onClick={() => setReceiptOpen(null)}>
          <div className="chat-receipt-dialog" onClick={event => event.stopPropagation()}>
            <p className="chat-panel-title">消息已读情况（按发送时最近 10 分钟内的最大在线人群统计）</p>
            {openReceipt ? (
              <>
                <section>
                  <h3 className="chat-receipt-heading">未读 · {openReceipt.unread.length}</h3>
                  {renderReceiptMembers(openReceipt.unread)}
                </section>
                <section>
                  <h3 className="chat-receipt-heading">已读 · {openReceipt.read.length}</h3>
                  {renderReceiptMembers(openReceipt.read)}
                </section>
              </>
            ) : <p className="muted-line">该消息的已读记录已不可用</p>}
            <div className="form-actions"><Button size="sm" variant="quiet" onClick={() => setReceiptOpen(null)}>关闭</Button></div>
          </div>
        </div>
      ) : null}

      {lightbox ? (
        <div className="chat-lightbox" role="dialog" aria-label={lightbox.name} onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- 聊天附件为受保护的动态地址 */}
          <img src={lightbox.src} alt={lightbox.name} onClick={event => event.stopPropagation()} />
          <div className="chat-lightbox-bar" onClick={event => event.stopPropagation()}>
            <span className="chat-lightbox-name">{lightbox.name}</span>
            {lightbox.download ? <a className="button button-secondary button-sm" href={lightbox.download} download={lightbox.name}>下载原图</a> : null}
            <Button size="sm" variant="quiet" onClick={() => setLightbox(null)}>关闭</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
