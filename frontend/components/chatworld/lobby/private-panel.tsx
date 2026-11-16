"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, jsonBody } from "../../../lib/api";
import { Button } from "../../ui/primitives";
import { Icon } from "../../ui/icon";
import { ChatEmojiPicker } from "../room/emoji-picker";
import { TodoPanel } from "../todo/todo-panel";

const BASE = "/api/chat-lobby/private-chat";
interface Contact { id: string; scene_id?: string; name: string; last: string; unread: number }
interface Message { seq: number; text: string; outgoing: number; created_at: number }

/** 私聊窗口：电脑可选择所有联系人，面对面只展示当前交谈对象。 */
export function PrivatePanel({ sceneId, onClose }: { sceneId?: string; onClose?: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const lastMessage = messages.at(-1)?.seq;
  // 与聊天室一致：输入框随内容增高，新消息在阅读底部时自动滚动。
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  }, [draft, selected]);
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
  const insertEmoji = (emoji: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    if (draft.length - (end - start) + emoji.length > 1000) return;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length); });
  };
  const request = useRef({ text: "", id: "" });
  const source = sceneId ? "near" : "desk";
  const loadContacts = useCallback(async () => {
    const rows = await apiFetch<Contact[]>(`${BASE}/contacts`);
    setContacts(rows);
    if (sceneId) {
      const peer = rows.find(c => c.scene_id === sceneId);
      if (peer) setSelected(peer.id);
    }
  }, [sceneId]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void loadContacts().catch(e => setError(String(e))); }, 0);
    const update = () => { void loadContacts().catch(() => undefined); };
    window.addEventListener("lobby-private-chat", update);
    const timer = window.setInterval(update, 5000);
    return () => { clearTimeout(initial); window.removeEventListener("lobby-private-chat", update); clearInterval(timer); };
  }, [loadContacts]);
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
        setMessages(previous => { const latest = new Map((replace ? [] : previous).map(m => [m.seq, m])); for (const m of rows) latest.set(m.seq, m); return [...latest.values()].sort((a,b)=>a.seq-b.seq); });
        initial = false;
        const seq = rows.at(-1)?.seq ?? 0;
        if (seq > lastRead && document.visibilityState === "visible" && document.hasFocus()) {
          lastRead = seq;
          await apiFetch(`${BASE}/${selected}/read`, {method: "PUT", body: jsonBody({seq})});
        }
      } catch (e) { if (alive) setError(String(e)); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 2000);
    window.addEventListener("lobby-private-chat", load);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("lobby-private-chat", load); };
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    let first = true;
    const check = async () => {
      try {
        const result = await apiFetch<{allowed:boolean}>(`${BASE}/${selected}/open`, {method:"POST", body:jsonBody({source, opening: first && Boolean(sceneId)})});
        first = false;
        if (alive && !result.allowed) { setError("交谈已结束，请靠近对方或前往自己的工位电脑"); onClose?.(); }
      } catch { /* 短暂断线由发送确认与下一次检查处理 */ }
    };
    void check();
    const timer = window.setInterval(check, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [selected, source, sceneId, onClose]);
  const send = async () => {
    if (busy || !draft.trim() || !selected) return;
    setBusy(true); setError("");
    if (request.current.text !== draft) request.current = {text: draft, id: crypto.randomUUID()};
    try {
      await apiFetch(`${BASE}/${selected}/messages`, {method:"POST", body:jsonBody({source, text:draft, request_id:request.current.id})});
      stickToBottom.current = true;
      setEmojiOpen(false);
      setDraft(""); request.current = {text:"",id:""};
      window.dispatchEvent(new Event("lobby-private-chat"));
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); requestAnimationFrame(() => inputRef.current?.focus()); }
  };
  return <div className="private-panel">
    {!sceneId && <aside><h2>私聊</h2><input aria-label="搜索联系人" placeholder="搜索联系人" value={query} onChange={e => setQuery(e.target.value)} />{[...contacts].sort((a,b)=>Number(Boolean(b.last))-Number(Boolean(a.last))).filter(c=>c.name.includes(query)).map(c=><button type="button" key={c.id} aria-pressed={selected===c.id} onClick={()=>{setSelected(c.id);setMessages([]);setDraft("");setError("");setEmojiOpen(false);stickToBottom.current=true;}}>{c.name}{c.unread ? ` · ${c.unread} 条未读` : ""}<small>{c.last || "开始新会话"}</small></button>)}</aside>}
    <section><h2>{contacts.find(c=>c.id===selected)?.name || "选择联系人"}</h2>
      {error && <p role="alert">{error}</p>}
      <div className="private-messages chat-messages" ref={listRef} aria-live="polite" onScroll={event => { const el = event.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
        {messages.length>=50 && <button type="button" onClick={async()=>{try {const older=await apiFetch<Message[]>(`${BASE}/${selected}/messages?before=${messages[0].seq}`);setMessages(rows=>[...older,...rows]);}catch(e){setError(String(e));}}}>加载更早消息</button>}
        {messages.map(m => <div key={m.seq} className={`chat-row${m.outgoing ? " chat-row-mine" : ""}`}>
          <div className="chat-message">
            <span className="chat-message-meta"><strong>{m.outgoing ? "我" : contacts.find(c => c.id === selected)?.name}</strong> · {new Date(m.created_at * 1000).toLocaleString()}</span>
            <div className="chat-bubble">{m.text}</div>
          </div>
        </div>)}
      </div>
      {selected && <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea ref={inputRef} aria-label="私聊消息" rows={1} maxLength={1000} value={draft} disabled={busy}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行" onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        <div className="chat-emoji-anchor" ref={emojiRef}>
          <button type="button" className={`chat-emoji-toggle${emojiOpen ? " chat-toolbar-active" : ""}`} disabled={busy}
            onClick={() => setEmojiOpen(open => !open)} aria-label="表情" aria-expanded={emojiOpen}><Icon name="smile" /></button>
          {emojiOpen && <div className="chat-emoji-popover"><ChatEmojiPicker onSelect={insertEmoji} /></div>}
        </div>
        <Button type="submit" disabled={busy || !draft.trim()}>{busy ? "发送中…" : "发送"}</Button>
      </form>}

    </section>
  </div>;
}

/** 自己工位上的电脑，保留待办入口。 */
export function DeskComputer({ onClose }: { onClose?: () => void }) {
  const [tab,setTab]=useState("todo");
  return <><nav className="private-tabs"><button onClick={()=>setTab("todo")} aria-pressed={tab==="todo"}>待办</button><button onClick={()=>setTab("private")} aria-pressed={tab==="private"}>私聊</button></nav>{tab==="todo"?<TodoPanel/>:<PrivatePanel onClose={onClose}/>}</>;
}

/** 大厅中仅显示未读提示，打开仍通过场景距离验证。 */
export function PrivateNotice() {
  const [count,setCount]=useState(0);
  const [rows,setRows]=useState<Contact[]>([]);
  useEffect(()=>{
    const load=()=>{void apiFetch<Contact[]>(`${BASE}/contacts`).then(rows=>{setRows(rows);setCount(rows.reduce((n,c)=>n+c.unread,0));}).catch(()=>undefined);};
    load(); window.addEventListener("lobby-private-chat",load);
    const timer=window.setInterval(load,5000);
    return()=>{clearInterval(timer);window.removeEventListener("lobby-private-chat",load);};
  },[]);
  return count ? <button type="button" className="private-notice" onClick={async()=>{for(const peer of rows.filter(c=>c.unread && c.scene_id)){const result=await apiFetch<{allowed:boolean}>(`${BASE}/${peer.id}/open`,{method:"POST",body:jsonBody({source:"near",opening:true})});if(result.allowed){window.dispatchEvent(new CustomEvent("lobby-private-open",{detail:peer.scene_id}));return;}} window.alert("请面向对方按 E，或前往自己的工位电脑查看私聊");}}>{count} 条私聊未读 · 点击查看</button> : null;
}
