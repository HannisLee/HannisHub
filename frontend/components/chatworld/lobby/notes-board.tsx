"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  deleteLobbyNote, fetchLobbyNotes, LOBBY_NOTES_EVENT, NOTE_COLORS, NOTE_TEXT_MAX, postLobbyNote,
  type LobbyNote, type NoteColor,
} from "../../../lib/chat-lobby";
import { errorMessage } from "../../../lib/format";
import { Button, EmptyState, ErrorState, LoadingState, PageHeader } from "../../ui/primitives";

const COLOR_LABELS: Record<NoteColor, string> = {
  yellow: "黄", pink: "粉", blue: "蓝", green: "绿", orange: "橙", purple: "紫",
};

/** 便签时间：一小时内显示「几分钟前」，当天显示时刻，更早显示日期 */
function noteTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const now = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** 大厅留言板：所有人共享的便签墙。贴一张便签（最多 140 字、六种颜色），自己贴的可以撕掉，管理员可以撕掉任何一张；
 *  有人贴或撕时，场景收到同步通道的 notes 通知并派发窗口事件，面板随之刷新。 */
export function NotesBoard() {
  const [notes, setNotes] = useState<LobbyNote[] | null>(null);
  const [moderate, setModerate] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [color, setColor] = useState<NoteColor>("yellow");
  const [posting, setPosting] = useState(false);

  const load = useCallback(() => {
    fetchLobbyNotes()
      .then(state => {
        setNotes(state.notes);
        setModerate(state.can_moderate);
        setError("");
      })
      .catch(value => {
        setError(errorMessage(value));
        setNotes(current => current ?? []);
      });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(LOBBY_NOTES_EVENT, load);
    // 同步通道断开时的兜底刷新
    const timer = window.setInterval(load, 30_000);
    return () => {
      window.removeEventListener(LOBBY_NOTES_EVENT, load);
      window.clearInterval(timer);
    };
  }, [load]);

  async function post(event: FormEvent) {
    event.preventDefault();
    const content = text.trim();
    if (!content || posting) return;
    setPosting(true);
    try {
      const note = await postLobbyNote(content, color);
      setNotes(current => [note, ...(current ?? []).filter(item => item.id !== note.id)]);
      setText("");
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setPosting(false);
    }
  }

  async function remove(note: LobbyNote) {
    if (!window.confirm(note.mine ? "撕掉这张便签？" : `撕掉 ${note.name} 的这张便签？`)) return;
    try {
      await deleteLobbyNote(note.id);
      setNotes(current => current?.filter(item => item.id !== note.id) ?? current);
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  return <>
    <PageHeader kicker="聊天大厅 / 留言板" title="留言板" description="贴一张便签，大厅里的每个人都能看到。最新的贴在最前面。" />
    {error ? <ErrorState message={error} /> : null}

    <form className="notes-compose" onSubmit={event => void post(event)}>
      <textarea
        className={`notes-compose-text note-${color}`}
        rows={3}
        value={text}
        maxLength={NOTE_TEXT_MAX}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void post(event);
        }}
        placeholder="写点什么：通知、心情、午饭约人……（Ctrl + Enter 贴上）"
        aria-label="便签内容"
      />
      <div className="notes-compose-bar">
        <div className="notes-colors" role="radiogroup" aria-label="便签颜色">
          {NOTE_COLORS.map(item => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={color === item}
              aria-label={`${COLOR_LABELS[item]}色便签`}
              className={`notes-swatch note-${item}${color === item ? " is-active" : ""}`}
              onClick={() => setColor(item)}
            />
          ))}
        </div>
        <span className="notes-count">{text.length}/{NOTE_TEXT_MAX}</span>
        <Button type="submit" size="sm" disabled={!text.trim() || posting}>{posting ? "贴上中…" : "贴上去"}</Button>
      </div>
    </form>

    {notes === null ? <LoadingState /> : notes.length ? (
      <ul className="notes-grid">
        {notes.map(note => (
          <li key={note.id} className={`note-card note-${note.color}`}>
            <p className="note-text">{note.text}</p>
            <div className="note-foot">
              <span className="note-author">{note.mine ? "我" : note.name}</span>
              <span className="note-time">{noteTime(note.created_at)}</span>
              {note.mine || moderate ? (
                <button type="button" className="note-remove" onClick={() => void remove(note)} aria-label="撕掉这张便签" title="撕掉">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    ) : <EmptyState title="留言板还是空的" detail="贴上第一张便签吧。" />}
  </>;
}
