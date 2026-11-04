"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { AuthStatus, ChatRoomMessage, ChatRoomMessages } from "../../lib/types";
import { Button, ErrorState, LoadingState } from "../ui/primitives";

const MESSAGES = `${API_PATHS.chatRoom}/messages`;
const NICKNAME_KEY = "hannishub_chat_nickname";
const POLL_MS = 2000;

function readNickname(): string {
  try {
    return window.localStorage.getItem(NICKNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveNickname(value: string) {
  try {
    window.localStorage.setItem(NICKNAME_KEY, value);
  } catch {
    // 浏览器禁用存储时仅在本次页面内生效
  }
}

function formatTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 公共聊天室：一个共享消息窗口，按昵称区分发言人，每 2 秒增量拉取新消息 */
export function ChatRoom() {
  const [messages, setMessages] = useState<ChatRoomMessage[]>([]);
  const [nickname, setNickname] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const lastIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const merge = useCallback((incoming: ChatRoomMessage[]) => {
    if (incoming.length === 0) return;
    setMessages(current => {
      const known = new Set(current.map(item => item.id));
      const next = [...current, ...incoming.filter(item => !known.has(item.id))];
      lastIdRef.current = next.length ? next[next.length - 1].id : lastIdRef.current;
      return next;
    });
  }, []);

  const poll = useCallback(async () => {
    try {
      const data = await apiFetch<ChatRoomMessages>(`${MESSAGES}?after=${lastIdRef.current}`);
      // 记录被清空时（服务端为空而本地有消息）同步清空
      if (data.total === 0) {
        setMessages([]);
      } else {
        merge(data.messages);
      }
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    }
  }, [merge]);

  useEffect(() => {
    void (async () => {
      // 在异步回调内读取本地昵称，避免静态导出时与服务端渲染不一致
      setNickname(readNickname());
      try {
        // 未手动设置过昵称时，默认使用当前登录账号名
        if (!readNickname()) {
          const auth = await apiFetch<AuthStatus>("/api/auth/status").catch(() => null);
          if (auth?.username) setNickname(current => current || auth.username || "");
        }
        const data = await apiFetch<ChatRoomMessages>(MESSAGES);
        merge(data.messages);
      } catch (value) {
        setError(errorMessage(value));
      } finally {
        setLoading(false);
      }
    })();
    const timer = window.setInterval(() => {
      if (!document.hidden) void poll();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [merge, poll]);

  // 用户停留在底部时，新消息自动滚动到底
  useEffect(() => {
    const box = listRef.current;
    if (box && stickToBottomRef.current) box.scrollTop = box.scrollHeight;
  }, [messages]);

  function onScroll() {
    const box = listRef.current;
    if (box) stickToBottomRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }

  async function send() {
    const content = draft.trim();
    const name = nickname.trim();
    if (!content || !name || sending) return;
    setSending(true);
    try {
      saveNickname(name);
      const message = await apiFetch<ChatRoomMessage>(MESSAGES, { method: "POST", body: jsonBody({ nickname: name, content }) });
      stickToBottomRef.current = true;
      merge([message]);
      setDraft("");
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

  const me = nickname.trim();

  return (
    <section className="chat-main">
      <header className="chat-main-head">
        <div className="chat-main-heading">
          <h2 className="chat-main-title">聊天室</h2>
          <span className="chat-main-meta">{messages.length} 条记录</span>
        </div>
      </header>

      <div className="chat-messages" ref={listRef} onScroll={onScroll}>
        {loading ? <LoadingState label="正在读取聊天记录…" /> : null}
        {messages.map((message, index) => {
          const mine = me !== "" && message.nickname === me;
          const grouped = index > 0 && messages[index - 1].nickname === message.nickname && message.created_at - messages[index - 1].created_at < 300;
          return (
            <div key={message.id} className={`chat-message ${mine ? "chat-message-user" : "chat-message-assistant"}${grouped ? " chat-message-grouped" : ""}`}>
              {grouped ? null : <span className="chat-message-meta"><strong>{message.nickname}</strong> · {formatTime(message.created_at)}</span>}
              <div className="chat-bubble">{message.content}</div>
            </div>
          );
        })}
      </div>

      {error ? <ErrorState message={error} /> : null}

      <div className="chat-composer">
        <input
          className="chat-nickname"
          value={nickname}
          onChange={event => setNickname(event.target.value)}
          onBlur={() => saveNickname(nickname.trim())}
          placeholder="昵称"
          maxLength={24}
          aria-label="昵称"
        />
        <textarea
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={me ? "输入消息，Enter 发送，Shift + Enter 换行" : "先在左侧填写昵称"}
          rows={2}
        />
        <Button onClick={() => void send()} disabled={sending || !draft.trim() || !me}>发送</Button>
      </div>
    </section>
  );
}
