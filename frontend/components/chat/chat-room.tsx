"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatShortDate } from "../../lib/format";
import type { AiSettings, ChatConversation, ChatConversationSummary } from "../../lib/types";
import { Button, EmptyState, ErrorState, LoadingState } from "../ui/primitives";

const CONVERSATIONS = `${API_PATHS.chatRoom}/conversations`;

function conversationPath(id: string) {
  return `${CONVERSATIONS}/${encodePath(id)}`;
}

/** 聊天室：左侧会话列表，右侧消息流与输入框，使用统一 AI 配置回复 */
export function ChatRoom() {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    const data = await apiFetch<{ conversations: ChatConversationSummary[] }>(CONVERSATIONS);
    setConversations(data.conversations);
    return data.conversations;
  }, []);

  const openConversation = useCallback(async (id: string) => {
    try {
      setActive(await apiFetch<ChatConversation>(conversationPath(id)));
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [list, settings] = await Promise.all([loadList(), apiFetch<AiSettings>(API_PATHS.aiSettings)]);
        setAiSettings(settings);
        if (list[0]) await openConversation(list[0].id);
      } catch (value) {
        setError(errorMessage(value));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadList, openConversation]);

  // 新消息到达后滚动到底部
  useEffect(() => {
    const box = messagesRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [active?.messages.length, sending]);

  async function createConversation() {
    try {
      const created = await apiFetch<ChatConversation>(CONVERSATIONS, { method: "POST", body: jsonBody({}) });
      setActive(created);
      await loadList();
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function removeConversation(id: string) {
    try {
      await apiFetch(conversationPath(id), { method: "DELETE" });
      const list = await loadList();
      if (active?.id === id) {
        if (list[0]) await openConversation(list[0].id);
        else setActive(null);
      }
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function changeConfig(configId: string) {
    if (!active) return;
    try {
      setActive(await apiFetch<ChatConversation>(conversationPath(active.id), { method: "PATCH", body: jsonBody({ config_id: configId }) }));
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    let target = active;
    setSending(true);
    setError("");
    try {
      if (!target) {
        target = await apiFetch<ChatConversation>(CONVERSATIONS, { method: "POST", body: jsonBody({}) });
      }
      // 先乐观展示用户消息，等待 AI 回复
      setActive({ ...target, messages: [...target.messages, { role: "user", content, created_at: Date.now() / 1000 }] });
      setDraft("");
      const updated = await apiFetch<ChatConversation>(`${conversationPath(target.id)}/messages`, {
        method: "POST",
        body: jsonBody({ content }),
      });
      setActive(updated);
    } catch (value) {
      setError(errorMessage(value));
      // 失败时以服务端为准重新读取（用户消息已保存）
      if (target) await openConversation(target.id);
    } finally {
      setSending(false);
      void loadList().catch(() => undefined);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  if (loading) return <LoadingState label="正在读取会话…" />;

  const configs = aiSettings?.ai_configs ?? [];

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <Button size="sm" variant="secondary" onClick={() => void createConversation()}>新建对话</Button>
        <div className="chat-conversation-list">
          {conversations.length === 0 ? <p className="muted-line">还没有会话</p> : null}
          {conversations.map(item => (
            <div key={item.id} className={`chat-conversation${active?.id === item.id ? " chat-conversation-active" : ""}`}>
              <button type="button" className="chat-conversation-open" onClick={() => void openConversation(item.id)}>
                <span className="chat-conversation-title">{item.title}</span>
                <span className="chat-conversation-meta">{formatShortDate(item.updated_at)} · {item.message_count} 条</span>
              </button>
              <button type="button" className="chat-conversation-delete" aria-label={`删除 ${item.title}`} onClick={() => void removeConversation(item.id)}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-main-head">
          <h2 className="chat-main-title">{active?.title ?? "新对话"}</h2>
          <select
            className="select-compact"
            value={active?.config_id ?? ""}
            disabled={!active}
            onChange={event => void changeConfig(event.target.value)}
            aria-label="AI 配置"
          >
            <option value="">跟随当前启用配置</option>
            {configs.map(config => <option key={config.id} value={config.id}>{config.name} · {config.model || "未选模型"}</option>)}
          </select>
        </header>

        <div className="chat-messages" ref={messagesRef}>
          {!active || active.messages.length === 0 ? (
            <EmptyState title="开始一段对话" detail="消息将使用「AI 能力」中配置的 OpenAI 兼容接口回复。" />
          ) : (
            active.messages.map((message, index) => (
              <div key={`${message.created_at}-${index}`} className={`chat-message chat-message-${message.role}`}>
                <div className="chat-bubble">{message.content}</div>
                {message.role === "assistant" && message.model ? <span className="chat-message-meta">{message.config_name} · {message.model}</span> : null}
              </div>
            ))
          )}
          {sending ? <div className="chat-message chat-message-assistant"><div className="chat-bubble chat-bubble-pending"><span className="loading-line" />正在回复…</div></div> : null}
        </div>

        {error ? <ErrorState message={error} /> : null}

        <div className="chat-composer">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入消息，Enter 发送，Shift + Enter 换行"
            rows={3}
          />
          <Button onClick={() => void send()} disabled={sending || !draft.trim()}>发送</Button>
        </div>
      </section>
    </div>
  );
}
