"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import type { TerminalSession, TerminalSessionList } from "../../lib/types";

/** 本地会话：expiresAt 为按服务端剩余秒数换算的本地释放时刻（毫秒） */
type LocalSession = TerminalSession & { expiresAt: number };

function withDeadline(session: TerminalSession): LocalSession {
  return { ...session, expiresAt: Date.now() + session.expires_in * 1000 };
}
import { Icon } from "../ui/icon";
import { Button } from "../ui/primitives";
import type { TerminalEndReason } from "./terminal-view";

const TerminalView = dynamic(() => import("./terminal-view"), { ssr: false });

const ACTIVE_STORAGE_KEY = "hannishub_terminal_active";
const LIST_REFRESH_MS = 30_000;

const END_NOTICE: Record<TerminalEndReason, string> = {
  exit: "已退出",
  released: "因长时间无操作已被释放",
  closed: "已在其他页面关闭",
  missing: "已不存在（可能 Hub 已重启）",
  forbidden: "无权访问",
};

function readStoredActive(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeActive(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_STORAGE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_STORAGE_KEY);
  } catch {
    return;
  }
}

function formatRemaining(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.max(0, Math.floor(seconds))} 秒`;
}

export function TerminalWorkspace() {
  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(6 * 3600);
  const [now, setNow] = useState(0);
  const sessionsRef = useRef<LocalSession[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    storeActive(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<TerminalSessionList>(`${API_PATHS.terminal}/sessions`);
      setNow(Date.now());
      setSessions(data.sessions.map(withDeadline));
      setTimeoutSeconds(data.idle_timeout_seconds);
      setError("");
      setActiveIdState(current => {
        const ids = data.sessions.map(item => item.id);
        if (current && ids.includes(current)) return current;
        const stored = readStoredActive();
        return stored && ids.includes(stored) ? stored : ids[0] ?? null;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取终端列表");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // 首次载入与定时刷新：同步其他页面/设备上新建或关闭的终端与剩余时间
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), LIST_REFRESH_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.clearInterval(clock);
    };
  }, [refresh]);

  async function createSession() {
    setCreating(true);
    setNotice("");
    try {
      const data = await apiFetch<{ session: TerminalSession }>(`${API_PATHS.terminal}/sessions`, { method: "POST", body: jsonBody({}) });
      setNow(Date.now());
      setSessions(current => [...current, withDeadline(data.session)]);
      setActiveId(data.session.id);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新建终端失败");
    } finally {
      setCreating(false);
    }
  }

  const removeLocal = useCallback((id: string) => {
    const current = sessionsRef.current;
    const index = current.findIndex(item => item.id === id);
    const next = current.filter(item => item.id !== id);
    sessionsRef.current = next;
    setSessions(next);
    setActiveIdState(active => {
      if (active !== id) return active;
      const fallback = next[Math.min(index, next.length - 1)]?.id ?? null;
      storeActive(fallback);
      return fallback;
    });
  }, []);

  async function closeSession(session: LocalSession) {
    if (!window.confirm(`关闭「${session.title}」？其中正在运行的程序会被结束。`)) return;
    try {
      await apiFetch(`${API_PATHS.terminal}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    } catch {
      // 已不存在时同样从列表移除
    }
    removeLocal(session.id);
  }

  const onEnded = useCallback((id: string, reason: TerminalEndReason) => {
    const session = sessionsRef.current.find(item => item.id === id);
    if (session && reason !== "closed") setNotice(`「${session.title}」${END_NOTICE[reason]}`);
    removeLocal(id);
  }, [removeLocal]);

  const onActivity = useCallback((id: string) => {
    // 本地估算：有输入即视为重新计时，定时刷新时以服务端为准
    const deadline = Date.now() + timeoutSeconds * 1000;
    setSessions(current => current.map(item => (item.id === id && item.expiresAt < deadline - 60_000 ? { ...item, expiresAt: deadline } : item)));
  }, [timeoutSeconds]);

  const onStatus = useCallback((id: string, value: boolean) => {
    setConnected(current => (current[id] === value ? current : { ...current, [id]: value }));
  }, []);

  async function commitRename() {
    if (!editing) return;
    const { id, value } = editing;
    setEditing(null);
    const title = value.trim();
    if (!title || sessions.find(item => item.id === id)?.title === title) return;
    try {
      const data = await apiFetch<{ session: TerminalSession }>(`${API_PATHS.terminal}/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: jsonBody({ title }) });
      setSessions(current => current.map(item => (item.id === id ? { ...item, title: data.session.title } : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重命名失败");
    }
  }

  function onRenameKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") void commitRename();
    if (event.key === "Escape") setEditing(null);
  }

  const remainingOf = (session: LocalSession) => Math.max(0, (session.expiresAt - now) / 1000);
  const active = sessions.find(item => item.id === activeId) ?? null;
  const remaining = active ? remainingOf(active) : 0;

  return (
    <div className="terminal-workspace">
      <div className="terminal-tabbar" role="tablist" aria-label="终端列表">
        <div className="terminal-tabs">
          {sessions.map(session => (
            <div
              key={session.id}
              role="tab"
              aria-selected={session.id === activeId}
              tabIndex={0}
              className={`terminal-tab${session.id === activeId ? " is-active" : ""}`}
              onClick={() => setActiveId(session.id)}
              onKeyDown={event => { if (event.key === "Enter") setActiveId(session.id); }}
              onDoubleClick={() => setEditing({ id: session.id, value: session.title })}
              title={`${session.title} · 双击重命名 · 约 ${formatRemaining(remainingOf(session))}后因无操作释放`}
            >
              <span className={`terminal-tab-dot${connected[session.id] ? " is-online" : ""}`} />
              {editing?.id === session.id ? (
                <input
                  className="terminal-tab-input"
                  value={editing.value}
                  autoFocus
                  maxLength={40}
                  onChange={event => setEditing({ id: session.id, value: event.target.value })}
                  onBlur={() => void commitRename()}
                  onKeyDown={onRenameKey}
                  onClick={event => event.stopPropagation()}
                />
              ) : (
                <span className="terminal-tab-title">{session.title}</span>
              )}
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={`关闭 ${session.title}`}
                title="关闭终端"
                onClick={event => { event.stopPropagation(); void closeSession(session); }}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="terminal-new" onClick={() => void createSession()} disabled={creating} title="新建终端" aria-label="新建终端">
          <Icon name="plus" />
        </button>
      </div>

      {error ? <div className="terminal-message is-error">{error}</div> : null}
      {notice ? (
        <div className="terminal-message">
          {notice}
          <button type="button" className="terminal-message-dismiss" onClick={() => setNotice("")} aria-label="关闭提示"><Icon name="close" /></button>
        </div>
      ) : null}

      <div className="terminal-stage">
        {sessions.map(session => (
          <TerminalView key={session.id} sessionId={session.id} active={session.id === activeId} onEnded={onEnded} onActivity={onActivity} onStatus={onStatus} />
        ))}
        {loaded && sessions.length === 0 ? (
          <div className="terminal-empty">
            <p>还没有终端。终端在关闭网页后继续运行，{formatRemaining(timeoutSeconds)}无操作后自动释放。</p>
            <Button onClick={() => void createSession()} disabled={creating}>新建终端</Button>
          </div>
        ) : null}
      </div>

      {active ? (
        <div className="terminal-statusbar">
          <span>PID {active.pid}</span>
          <span>{connected[active.id] ? "已连接" : "连接中…"}</span>
          <span>约 {formatRemaining(remaining)}后因无操作释放</span>
        </div>
      ) : null}
    </div>
  );
}
