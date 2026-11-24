"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiFetch, jsonBody } from "../../../lib/api";
import { fetchLobbyProfile, type LobbyProfile } from "../../../lib/chat-lobby";
import type { ChatAttachment } from "../../../lib/types";
import { errorMessage, formatBytes } from "../../../lib/format";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/primitives";
import { ChatEmojiPicker } from "../room/emoji-picker";
import { ChatAttachmentCard, ChatLightbox, INLINE_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, uploadChatAttachment, type LightboxImage } from "../shared/chat-attachment";
import { Avatar, formatChatTime } from "../shared/chat-avatar";
import { TodoPanel } from "../todo/todo-panel";
import { ADMIN_PRIVATE_VIEW_EVENT } from "../../../lib/admin-notify";
import { PRIVATE_MESSAGE_EVENT } from "../../../lib/online-notice-events";

const BASE = "/api/chat-lobby/private-chat";
/** 私聊有变化（新消息、已读）时的页面事件：WebSocket 定向通知与本页发送后都会派发 */
const PAGE_SIZE = 50;
const MESSAGE_MAX = 1000;

function messageRequestId() {
  // 局域网 HTTP 下也能生成请求编号。
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

interface Contact {
  id: string;
  scene_id?: string | null;
  name: string;
  /** 聊天头像（与「我的房间」设置一致） */
  photo: string;
  last: string;
  last_at: number;
  unread: number;
  /** 对方近期发来过消息：任意位置可回复 */
  can_reply: boolean;
}

interface Message { seq: number; text: string; outgoing: number; created_at: number; attachment?: ChatAttachment }

/** 私聊入口：
 *  - near：面对面按 E 发起，只显示当前交谈对象，走开后结束；
 *  - desk：自己的工位电脑，可向任何人发起；
 *  - inbox：点击大厅里的私聊提醒打开，任意位置查看，并可回复近期发来消息的人。 */
export type PrivateMode = "near" | "desk" | "inbox";

const NARROW_QUERY = "(max-width: 767px)";

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** 窄屏时缩短输入框提示，避免提示文字折行把输入框撑高 */
function useNarrow() {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW_QUERY).matches, () => false);
}

/** 有未读的排前面，其余按最近消息时间 */
function sortContacts(rows: Contact[]): Contact[] {
  return [...rows].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.last_at - a.last_at || a.name.localeCompare(b.name, "zh-CN"));
}

/** 联系人与未读数：每 5 秒及收到私聊事件时刷新 */
function usePrivateContacts() {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () => {
      apiFetch<Contact[]>(`${BASE}/contacts`)
        .then(rows => { if (alive) { setContacts(rows); setError(""); } })
        .catch(value => { if (alive) setError(errorMessage(value)); });
    };
    const initial = window.setTimeout(load, 0);
    const timer = window.setInterval(load, 5000);
    window.addEventListener(PRIVATE_MESSAGE_EVENT, load);
    return () => {
      alive = false;
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener(PRIVATE_MESSAGE_EVENT, load);
    };
  }, []);
  return { contacts, error };
}

interface PrivatePanelProps {
  mode: PrivateMode;
  /** near：交谈对象在场景中的编号 */
  sceneId?: string;
  /** inbox：打开时选中的联系人 */
  contactId?: string;
  onClose?: () => void;
}

/** 私聊窗口：左侧联系人（面对面时隐藏），右侧消息与发送区；窄屏时联系人与会话分两屏切换。 */
export function PrivatePanel({ mode, sceneId, contactId, onClose }: PrivatePanelProps) {
  const { contacts: loaded, error: contactsError } = usePrivateContacts();
  const contacts = useMemo(() => loaded ?? [], [loaded]);
  const [picked, setPicked] = useState(mode === "inbox" ? contactId ?? "" : "");
  const [me, setMe] = useState<LobbyProfile | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<{ file: File; previewUrl?: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 能否向当前联系人发消息；null 表示正在确认
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const sending = useRef(false);
  const uploaded = useRef<{ file: File; id: string } | null>(null);
  const request = useRef<{ text: string; attachmentId?: string; id: string } | null>(null);
  const narrow = useNarrow();

  // 面对面时交谈对象由场景编号决定
  const selected = mode === "near" ? contacts.find(c => c.scene_id === sceneId)?.id ?? "" : picked;
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(ADMIN_PRIVATE_VIEW_EVENT, { detail: selected || null }));
    return () => { window.dispatchEvent(new CustomEvent(ADMIN_PRIVATE_VIEW_EVENT, { detail: null })); };
  }, [selected]);
  const peer = contacts.find(c => c.id === selected);
  const lastMessage = messages.at(-1)?.seq;

  useEffect(() => {
    let alive = true;
    fetchLobbyProfile().then(profile => { if (alive) setMe(profile); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  // 面对面打开后对方已不在场景中（离线、换房间）
  useEffect(() => {
    if (mode === "near" && loaded && !selected) onClose?.();
  }, [mode, loaded, selected, onClose]);

  const choose = (id: string) => {
    if (sending.current || id === selected) return;
    setAttachment(null);
    setLightbox(null);
    uploaded.current = null;
    request.current = null;
    setPicked(id);
    setMessages([]);
    setHasMore(false);
    setDraft("");
    setError("");
    setAllowed(null);
    setEmojiOpen(false);
    stickToBottom.current = true;
  };

  useEffect(() => {
    const url = attachment?.previewUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [attachment]);

  // 与聊天室一致：输入框随内容增高，新消息在阅读底部时自动滚动
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  }, [draft, selected, allowed]);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [lastMessage]);

  useEffect(() => {
    if (!emojiOpen) return;
    const outside = (event: PointerEvent) => {
      if (!emojiRef.current?.contains(event.target as Node)) setEmojiOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setEmojiOpen(false); inputRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [emojiOpen]);

  // 拉取当前会话最近 50 条（轮询 + 私聊事件），可见且聚焦时上报已读
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    let lastRead = 0;
    let initial = true;
    const load = async () => {
      try {
        const rows = await apiFetch<Message[]>(`${BASE}/${selected}/messages`);
        if (!alive) return;
        const replace = initial;
        if (replace) setHasMore(rows.length >= PAGE_SIZE);
        setMessages(previous => {
          const latest = new Map((replace ? [] : previous).map(m => [m.seq, m]));
          for (const m of rows) latest.set(m.seq, m);
          return [...latest.values()].sort((a, b) => a.seq - b.seq);
        });
        initial = false;
        const seq = rows.at(-1)?.seq ?? 0;
        if (seq > lastRead && document.visibilityState === "visible" && document.hasFocus()) {
          lastRead = seq;
          await apiFetch(`${BASE}/${selected}/read`, { method: "PUT", body: jsonBody({ seq }) });
          window.dispatchEvent(new Event(PRIVATE_MESSAGE_EVENT));
        }
      } catch (value) {
        if (alive) setError(errorMessage(value));
      }
    };
    const update = () => { void load(); };
    update();
    const timer = window.setInterval(update, 2000);
    window.addEventListener(PRIVATE_MESSAGE_EVENT, update);
    window.addEventListener("focus", update);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(PRIVATE_MESSAGE_EVENT, update);
      window.removeEventListener("focus", update);
    };
  }, [selected]);

  // 确认能否发送：面对面走开且对方没发来过消息时结束交谈；其余入口不能发送时改为只读
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    let first = true;
    const check = async () => {
      try {
        const result = await apiFetch<{ allowed: boolean }>(`${BASE}/${selected}/open`, {
          method: "POST",
          body: jsonBody({ source: mode, opening: first && mode === "near" }),
        });
        first = false;
        if (!alive) return;
        if (mode === "near" && !result.allowed) onClose?.();
        else setAllowed(result.allowed);
      } catch {
        // 短暂断线由发送确认与下一次检查处理
      }
    };
    const update = () => { void check(); };
    update();
    const timer = window.setInterval(update, mode === "near" ? 1000 : 4000);
    window.addEventListener(PRIVATE_MESSAGE_EVENT, update);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(PRIVATE_MESSAGE_EVENT, update);
    };
  }, [selected, mode, onClose]);

  const insertEmoji = (emoji: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    if (draft.length - (end - start) + emoji.length > MESSAGE_MAX) return;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length); });
  };

  const loadOlder = async () => {
    const list = listRef.current;
    const before = list ? list.scrollHeight - list.scrollTop : 0;
    try {
      const older = await apiFetch<Message[]>(`${BASE}/${selected}/messages?before=${messages[0].seq}`);
      setHasMore(older.length >= PAGE_SIZE);
      setMessages(rows => [...older, ...rows]);
      // 保持当前阅读位置不跳动
      requestAnimationFrame(() => { if (list) list.scrollTop = list.scrollHeight - before; });
    } catch (value) {
      setError(errorMessage(value));
    }
  };

  const stageAttachment = (files: FileList | null) => {
    if (!files?.length || !selected || allowed === false || sending.current) return;
    const file = files[0];
    if (files.length > 1) {
      setError("每条私聊可发送一个附件，请一次选择一个文件。");
      return;
    }
    if (!file.size || file.size > MAX_ATTACHMENT_BYTES) {
      setError(file.size ? `单个文件不能超过 ${MAX_ATTACHMENT_MB} MB` : "不能发送空文件");
      return;
    }
    setError("");
    uploaded.current = null;
    setAttachment({ file, previewUrl: INLINE_IMAGE_TYPES.has(file.type) ? URL.createObjectURL(file) : undefined });
  };

  const send = async () => {
    if (sending.current || (!draft.trim() && !attachment) || !selected || allowed !== true) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      let attachmentId: string | undefined;
      if (attachment) {
        if (uploaded.current?.file !== attachment.file) {
          setProgress(0);
          const result = await uploadChatAttachment(`${BASE}/${selected}/files?source=${mode}`, attachment.file, attachment.previewUrl, setProgress);
          uploaded.current = { file: attachment.file, id: result.id };
          setProgress(null);
        }
        attachmentId = uploaded.current.id;
      }
      if (request.current?.text !== draft || request.current.attachmentId !== attachmentId) {
        request.current = { text: draft, attachmentId, id: messageRequestId() };
      }
      await apiFetch(`${BASE}/${selected}/messages`, {
        method: "POST",
        body: jsonBody({ source: mode, text: draft, attachment_id: attachmentId, request_id: request.current.id }),
      });
      stickToBottom.current = true;
      setEmojiOpen(false);
      setDraft("");
      setAttachment(null);
      uploaded.current = null;
      request.current = null;
      window.dispatchEvent(new Event(PRIVATE_MESSAGE_EVENT));
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      sending.current = false;
      setBusy(false);
      setProgress(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const myName = me?.name ?? "我";
  const status = mode === "near" ? "面对面" : mode === "desk" ? "工位电脑" : allowed ? "可直接回复" : allowed === false ? "只读" : "";
  const shown = sortContacts(contacts).filter(c => c.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className={`private-panel${mode === "near" ? " is-single" : ""}${selected ? " has-selection" : ""}`}>
      {mode !== "near" ? (
        <aside className="private-contacts" aria-label="联系人">
          <input className="private-search" aria-label="搜索联系人" placeholder="搜索联系人" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="private-contact-list">
            {loaded === null && !contactsError ? <p className="private-muted">正在读取联系人…</p> : null}
            {contactsError ? <p className="private-muted">{contactsError}</p> : null}
            {loaded && shown.length === 0 ? <p className="private-muted">{query ? "没有匹配的联系人" : "还没有其他账号"}</p> : null}
            {shown.map(c => (
              <button type="button" key={c.id} className="private-contact" aria-pressed={selected === c.id} disabled={busy} onClick={() => choose(c.id)}>
                <Avatar nickname={c.name} avatar={c.photo} size="md" />
                <span className="private-contact-text">
                  <span className="private-contact-name">{c.name}</span>
                  <small>{c.last || "开始新会话"}</small>
                </span>
                {c.unread ? <span className="private-unread" aria-label={`${c.unread} 条未读`}>{c.unread > 99 ? "99+" : c.unread}</span> : null}
              </button>
            ))}
          </div>
        </aside>
      ) : null}

      <section className="private-thread"
        onDragOver={e => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = selected && allowed === true && !busy ? "copy" : "none";
        }}
        onDrop={e => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          stageAttachment(e.dataTransfer.files);
        }}>
        {peer ? (
          <header className="private-head">
            {mode !== "near" ? (
              <button type="button" className="private-back" disabled={busy} onClick={() => choose("")} aria-label="返回联系人列表">‹</button>
            ) : null}
            <Avatar nickname={peer.name} avatar={peer.photo} size="sm" />
            <h2 className="private-peer">{peer.name}</h2>
            {status ? <span className="private-status">{status}</span> : null}
          </header>
        ) : null}

        {!selected ? (
          <div className="private-empty">{mode === "near" ? "正在连接…" : "选择一位联系人查看私聊"}</div>
        ) : (
          <>
            {error ? <p className="private-error" role="alert">{error}</p> : null}
            <div className="private-messages chat-messages" ref={listRef} aria-live="polite"
              onScroll={event => { const el = event.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
              {hasMore ? <button type="button" className="private-more" onClick={() => void loadOlder()}>加载更早消息</button> : null}
              {messages.length === 0 ? <p className="private-muted private-hello">还没有消息，打个招呼吧</p> : null}
              {messages.map((m, index) => {
                const previous = messages[index - 1];
                const grouped = !!previous && previous.outgoing === m.outgoing && m.created_at - previous.created_at < 300;
                const name = m.outgoing ? myName : peer?.name ?? "";
                const photo = m.outgoing ? me?.photo : peer?.photo;
                const fileUrl = m.attachment ? `${BASE}/${selected}/files/${m.attachment.id}` : undefined;
                return (
                  <div key={m.seq} className={`chat-row${m.outgoing ? " chat-row-mine" : ""}${grouped ? " chat-row-grouped" : ""}`}>
                    {grouped ? <span className="chat-avatar-spacer" /> : <Avatar nickname={name} avatar={photo} />}
                    <div className="chat-message">
                      {grouped ? null : <span className="chat-message-meta"><strong>{name}</strong> · {formatChatTime(m.created_at)}</span>}
                      {m.text ? <div className="chat-bubble">{m.text}</div> : null}
                      {m.attachment ? <ChatAttachmentCard attachment={{ ...m.attachment, src: m.attachment.kind === "image" ? fileUrl : undefined }}
                        downloadHref={`${fileUrl}?download=true`} onOpen={setLightbox} /> : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {attachment && allowed !== false ? (
              <div className="private-attachment-draft">
                {attachment.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 本地图片通过临时地址预览
                  <img src={attachment.previewUrl} alt="" />
                ) : <Icon name="file" />}
                <span title={attachment.file.name}>{attachment.file.name}</span>
                <small role="status">{progress === null ? formatBytes(attachment.file.size) : `上传中 ${progress}%`}</small>
                <Button type="button" size="sm" variant="quiet" disabled={busy} onClick={() => { setAttachment(null); uploaded.current = null; }}>移除</Button>
              </div>
            ) : null}
            {allowed === false ? (
              <p className="private-locked">对方近期没有给你发消息。发起私聊请面对对方按 E，或坐到自己的工位电脑前。</p>
            ) : (
              <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
                <textarea ref={inputRef} aria-label="私聊消息" rows={1} maxLength={MESSAGE_MAX} value={draft} disabled={busy}
                  placeholder={narrow ? "输入消息" : "输入消息，Enter 发送，Shift+Enter 换行"} onChange={e => setDraft(e.target.value)}
                  onPaste={e => {
                    if (!e.clipboardData.files.length) return;
                    e.preventDefault();
                    stageAttachment(e.clipboardData.files);
                  }}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
                <input ref={fileInputRef} type="file" hidden onChange={e => {
                  stageAttachment(e.currentTarget.files);
                  e.currentTarget.value = "";
                }} />
                <button type="button" className="chat-emoji-toggle" disabled={busy || allowed !== true}
                  onClick={() => fileInputRef.current?.click()} aria-label="发送图片或文件" title={`发送图片或文件（不超过 ${MAX_ATTACHMENT_MB} MB）`}>
                  <Icon name="attach" />
                </button>
                <div className="chat-emoji-anchor" ref={emojiRef}>
                  <button type="button" className={`chat-emoji-toggle${emojiOpen ? " chat-toolbar-active" : ""}`} disabled={busy}
                    onClick={() => setEmojiOpen(open => !open)} aria-label="表情" aria-expanded={emojiOpen}><Icon name="smile" /></button>
                  {emojiOpen ? <div className="chat-emoji-popover"><ChatEmojiPicker onSelect={insertEmoji} /></div> : null}
                </div>
                <Button type="submit" disabled={busy || (!draft.trim() && !attachment) || allowed !== true}>{busy ? "发送中…" : "发送"}</Button>
              </form>
            )}
          </>
        )}
        {lightbox ? <ChatLightbox lightbox={lightbox} onClose={() => setLightbox(null)} /> : null}
      </section>
    </div>
  );
}

/** 自己工位上的电脑：待办与私聊两个标签，私聊可向任何人发起。 */
export function DeskComputer({ onClose }: { onClose?: () => void }) {
  const [tab, setTab] = useState<"todo" | "private">("todo");
  const { contacts } = usePrivateContacts();
  const unread = (contacts ?? []).reduce((n, c) => n + c.unread, 0);
  return (
    <div className="private-desk">
      <nav className="private-tabs" role="tablist" aria-label="工位电脑">
        <button type="button" role="tab" aria-selected={tab === "todo"} className={`lobby-avatar-tab${tab === "todo" ? " is-active" : ""}`} onClick={() => setTab("todo")}>待办</button>
        <button type="button" role="tab" aria-selected={tab === "private"} className={`lobby-avatar-tab${tab === "private" ? " is-active" : ""}`} onClick={() => setTab("private")}>
          私聊{unread ? <span className="private-unread">{unread > 99 ? "99+" : unread}</span> : null}
        </button>
      </nav>
      {tab === "todo" ? <div className="private-desk-scroll"><TodoPanel /></div> : <PrivatePanel mode="desk" onClose={onClose} />}
    </div>
  );
}

/** 游戏画面右上角的私聊提醒：有未读时显示感叹号，点击直接打开最近来信的会话（任意位置可查看与回复）。 */
export function PrivateBadge({ onOpen }: { onOpen: (contactId: string) => void }) {
  const { contacts } = usePrivateContacts();
  const unread = (contacts ?? []).filter(c => c.unread > 0).sort((a, b) => b.last_at - a.last_at);
  if (!unread.length) return null;
  const total = unread.reduce((n, c) => n + c.unread, 0);
  const latest = unread[0];
  const label = unread.length === 1 ? `${latest.name} 发来 ${total} 条私聊` : `${unread.length} 人发来 ${total} 条私聊`;
  return (
    <button type="button" className="lobby-private-badge" onClick={() => onOpen(latest.id)} title={`${label}，点击查看`} aria-label={`${label}，点击查看`}>
      <span className="lobby-private-mark" aria-hidden="true">!</span>
      <Avatar nickname={latest.name} avatar={latest.photo} size="sm" />
      <span className="lobby-private-text">{label}</span>
    </button>
  );
}
