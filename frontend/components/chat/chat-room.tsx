"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { AuthStatus, ChatRoomMessage, ChatRoomMessages, ChatRoomProfile } from "../../lib/types";
import { Button, ErrorState, LoadingState } from "../ui/primitives";
import { ChatEmojiPicker } from "./emoji-picker";

const MESSAGES = `${API_PATHS.chatRoom}/messages`;
const PROFILE = `${API_PATHS.chatRoom}/profile`;
const CLIENT_ID_KEY = "hannishub_chat_client_id";
const NICKNAME_KEY = "hannishub_chat_nickname";
const POLL_MS = 2000;
const AVATAR_SIZE = 96;
const PRESET_AVATARS = ["🐱", "🐶", "🦊", "🐼", "🐸", "🐧", "🦄", "🐙", "🐳", "🌵", "🍀", "🌙"];

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

/** 读取或生成本浏览器的聊天室标识；使用 getRandomValues 以兼容 http 局域网访问 */
function ensureClientId(): string {
  const saved = storageGet(CLIENT_ID_KEY);
  if (/^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  const id = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  storageSet(CLIENT_ID_KEY, id);
  return id;
}

function formatTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
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

/** 公共聊天室：顶部为在线人数与个人设置，中部为共享消息流，底部为输入框与表情面板 */
export function ChatRoom() {
  const [messages, setMessages] = useState<ChatRoomMessage[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ChatRoomProfile>>({});
  const [online, setOnline] = useState<string[]>([]);
  const [clientId, setClientId] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"" | "settings" | "online">("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [avatarDraft, setAvatarDraft] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNote, setProfileNote] = useState("");

  const lastIdRef = useRef(0);
  const profilesVersionRef = useRef(-1);
  const clientIdRef = useRef("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const me = profiles[clientId];

  const mergeMessages = useCallback((incoming: ChatRoomMessage[]) => {
    if (incoming.length === 0) return;
    setMessages(current => {
      const known = new Set(current.map(item => item.id));
      const next = [...current, ...incoming.filter(item => !known.has(item.id))];
      lastIdRef.current = next.length ? next[next.length - 1].id : lastIdRef.current;
      return next;
    });
  }, []);

  const fetchMessages = useCallback(async () => {
    const query = new URLSearchParams({
      after: String(lastIdRef.current),
      client_id: clientIdRef.current,
      profiles_version: String(profilesVersionRef.current),
    });
    const data = await apiFetch<ChatRoomMessages>(`${MESSAGES}?${query}`);
    setOnline(data.online);
    if (data.profiles) setProfiles(data.profiles);
    profilesVersionRef.current = data.profiles_version;
    // 服务端记录被清空时同步清空本地
    if (data.total === 0) setMessages([]);
    else mergeMessages(data.messages);
    return data;
  }, [mergeMessages]);

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

  useEffect(() => {
    void (async () => {
      const id = ensureClientId();
      clientIdRef.current = id;
      setClientId(id);
      try {
        const data = await fetchMessages();
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
      if (!document.hidden) {
        fetchMessages().then(() => setError("")).catch(value => setError(errorMessage(value)));
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [fetchMessages, saveProfile]);

  // 用户停留在底部时，新消息自动滚动到底
  useEffect(() => {
    const box = listRef.current;
    if (box && stickToBottomRef.current) box.scrollTop = box.scrollHeight;
  }, [messages]);

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

  function onScroll() {
    const box = listRef.current;
    if (box) stickToBottomRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
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

  async function send() {
    const content = draft.trim();
    if (!content || sending || !clientId) return;
    setSending(true);
    try {
      const message = await apiFetch<ChatRoomMessage>(MESSAGES, {
        method: "POST",
        body: jsonBody({ client_id: clientId, nickname: me?.nickname ?? "", content }),
      });
      stickToBottomRef.current = true;
      mergeMessages([message]);
      setDraft("");
      setEmojiOpen(false);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function isMine(message: ChatRoomMessage) {
    return message.client_id ? message.client_id === clientId : !!me && message.nickname === me.nickname;
  }

  function senderOf(message: ChatRoomMessage) {
    const profile = message.client_id ? profiles[message.client_id] : undefined;
    return { nickname: profile?.nickname ?? message.nickname, avatar: profile?.avatar ?? "" };
  }

  return (
    <section className="chat-main">
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
            {profileNote ? <p className="error-text">{profileNote}</p> : null}
            <div className="form-actions">
              <Button size="sm" onClick={() => void submitProfile()} disabled={savingProfile}>保存</Button>
              <Button size="sm" variant="quiet" onClick={() => setPanel("")}>取消</Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="chat-messages" ref={listRef} onScroll={onScroll}>
        {loading ? <LoadingState label="正在读取聊天记录…" /> : null}
        {messages.map((message, index) => {
          const mine = isMine(message);
          const sender = senderOf(message);
          const previous = messages[index - 1];
          const grouped = !!previous && (previous.client_id ?? previous.nickname) === (message.client_id ?? message.nickname) && message.created_at - previous.created_at < 300;
          return (
            <div key={message.id} className={`chat-row${mine ? " chat-row-mine" : ""}${grouped ? " chat-row-grouped" : ""}`}>
              {grouped ? <span className="chat-avatar-spacer" /> : <Avatar nickname={sender.nickname} avatar={sender.avatar} />}
              <div className="chat-message">
                {grouped ? null : <span className="chat-message-meta"><strong>{sender.nickname}</strong> · {formatTime(message.created_at)}</span>}
                <div className="chat-bubble">{message.content}</div>
              </div>
            </div>
          );
        })}
      </div>

      {error ? <ErrorState message={error} /> : null}

      <div className="chat-composer">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入消息，Enter 发送，Shift + Enter 换行"
          rows={1}
        />
        <div className="chat-emoji-anchor" ref={emojiRef}>
          <button type="button" className={`chat-emoji-toggle${emojiOpen ? " chat-toolbar-active" : ""}`} onClick={() => setEmojiOpen(open => !open)} aria-label="表情" aria-expanded={emojiOpen}>
            ☺
          </button>
          {emojiOpen ? <div className="chat-emoji-popover"><ChatEmojiPicker onSelect={insertEmoji} /></div> : null}
        </div>
        <Button onClick={() => void send()} disabled={sending || !draft.trim() || !clientId}>发送</Button>
      </div>
    </section>
  );
}
