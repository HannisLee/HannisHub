"use client";

import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { TerminalInputRecorder } from "../../lib/terminal-recorder";
import type { TerminalCommandGroup, TerminalCommandGroupList, TerminalSession, TerminalSessionList } from "../../lib/types";

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

function commandsFromText(value: string): string[] {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
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
  const [commandGroups, setCommandGroups] = useState<TerminalCommandGroup[]>([]);
  const [commandsLoaded, setCommandsLoaded] = useState(false);
  const [commandError, setCommandError] = useState("");
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [commandEditingId, setCommandEditingId] = useState<string | null>(null);
  const [commandName, setCommandName] = useState("");
  const [commandText, setCommandText] = useState("");
  const [commandSaving, setCommandSaving] = useState(false);
  const [commandFormError, setCommandFormError] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordedCommands, setRecordedCommands] = useState<string[]>([]);
  const [runningCommandId, setRunningCommandId] = useState<string | null>(null);
  const sessionsRef = useRef<LocalSession[]>([]);
  const recorderRef = useRef<TerminalInputRecorder | null>(null);
  const recordingRef = useRef(false);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const getRecorder = useCallback(() => {
    recorderRef.current ??= new TerminalInputRecorder();
    return recorderRef.current;
  }, []);

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

  const refreshCommands = useCallback(async () => {
    try {
      const data = await apiFetch<TerminalCommandGroupList>(`${API_PATHS.terminal}/commands`);
      setCommandGroups(data.commands);
      setCommandError("");
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : "无法读取命令组");
    } finally {
      setCommandsLoaded(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCommands(), 0);
    const interval = window.setInterval(() => void refreshCommands(), LIST_REFRESH_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [refreshCommands]);

  const onTerminalInput = useCallback((_id: string, data: string) => {
    if (!recordingRef.current) return;
    const completed = getRecorder().consume(data);
    if (!completed.length) return;
    setRecordedCommands(current => [...current, ...completed].slice(0, 20));
  }, [getRecorder]);

  async function createSession() {
    setCreating(true);
    setNotice("");
    try {
      const data = await apiFetch<{ session: TerminalSession }>(`${API_PATHS.terminal}/sessions`, { method: "POST", body: jsonBody({}) });
      const session = withDeadline(data.session);
      setSessions(current => [...current, session]);
      setNow(session.expiresAt - data.session.expires_in * 1000);
      setActiveId(data.session.id);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新建终端失败");
    } finally {
      setCreating(false);
    }
  }

  function openCommandDialog(group?: TerminalCommandGroup) {
    const keepRecordingDraft = !group && recordingRef.current;
    recordingRef.current = false;
    setRecording(false);
    setCommandDialogOpen(true);
    setCommandEditingId(group?.id ?? null);
    setCommandName(group?.name ?? commandName);
    setCommandText(group?.commands.join("\n") ?? (keepRecordingDraft ? recordedCommands.join("\n") : commandText));
    setRecordedCommands(group?.commands ?? recordedCommands);
    setCommandFormError("");
  }

  function closeCommandDialog() {
    setCommandDialogOpen(false);
    recordingRef.current = false;
    setRecording(false);
  }

  function startRecording() {
    const initial = commandsFromText(commandText);
    if (!sessionsRef.current.length) {
      setCommandFormError("请先新建一个终端，再开始录制。");
      return;
    }
    getRecorder().reset();
    setRecordedCommands(initial);
    recordingRef.current = true;
    setRecording(true);
    setCommandDialogOpen(false);
    setCommandFormError("");
    setNotice("正在录制终端输入：请完整输入命令并回车，历史补全和 Tab 补全不会进入录制内容。");
  }

  function finishRecording() {
    recordingRef.current = false;
    setRecording(false);
    setCommandText(recordedCommands.join("\n"));
    setCommandDialogOpen(true);
  }

  async function saveCommandGroup() {
    const name = commandName.trim();
    const commands = (recording ? recordedCommands : commandsFromText(commandText));
    if (!name) {
      setCommandFormError("请填写命令组名称");
      return;
    }
    if (!commands.length) {
      setCommandFormError("至少填写或录制一条命令");
      return;
    }
    setCommandSaving(true);
    setCommandFormError("");
    try {
      const path = commandEditingId
        ? `${API_PATHS.terminal}/commands/${encodeURIComponent(commandEditingId)}`
        : `${API_PATHS.terminal}/commands`;
      const data = await apiFetch<{ command: TerminalCommandGroup }>(path, {
        method: commandEditingId ? "PATCH" : "POST",
        body: jsonBody({ name, commands }),
      });
      setCommandGroups(current => {
        if (!commandEditingId) return [...current, data.command];
        return current.map(item => (item.id === commandEditingId ? data.command : item));
      });
      setCommandDialogOpen(false);
      recordingRef.current = false;
      setRecording(false);
      setNotice(`已保存命令组「${data.command.name}」`);
    } catch (reason) {
      setCommandFormError(reason instanceof Error ? reason.message : "保存命令组失败");
    } finally {
      setCommandSaving(false);
    }
  }

  async function deleteCommandGroup(group: TerminalCommandGroup) {
    if (!window.confirm(`删除命令组「${group.name}」？`)) return;
    try {
      await apiFetch(`${API_PATHS.terminal}/commands/${encodeURIComponent(group.id)}`, { method: "DELETE" });
      setCommandGroups(current => current.filter(item => item.id !== group.id));
      if (commandEditingId === group.id) closeCommandDialog();
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : "删除命令组失败");
    }
  }

  async function runCommandGroup(group: TerminalCommandGroup) {
    setRunningCommandId(group.id);
    setNotice("");
    try {
      const data = await apiFetch<{ session: TerminalSession }>(
        `${API_PATHS.terminal}/commands/${encodeURIComponent(group.id)}/run`,
        { method: "POST" },
      );
      const session = withDeadline(data.session);
      setSessions(current => [...current, session]);
      setNow(session.expiresAt - data.session.expires_in * 1000);
      setActiveId(data.session.id);
      setError("");
      setNotice(`已新建「${group.name}」终端，${group.commands.length} 条命令已提交执行。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "执行命令组失败");
    } finally {
      setRunningCommandId(null);
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

  function onRenameKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") void commitRename();
    if (event.key === "Escape") setEditing(null);
  }

  const remainingOf = (session: LocalSession) => Math.max(0, (session.expiresAt - now) / 1000);
  const active = sessions.find(item => item.id === activeId) ?? null;
  const remaining = active ? remainingOf(active) : 0;
  const savedCommandCount = commandGroups.reduce((total, group) => total + group.commands.length, 0);
  const storageStatus = commandError
    ? "存储读取失败"
    : !commandsLoaded
      ? "存储读取中…"
      : commandGroups.length
        ? `已存 ${commandGroups.length} 组 / ${savedCommandCount} 条`
        : "尚未存储";

  useEffect(() => {
    if (!commandDialogOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCommandDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commandDialogOpen]);

  return (
    <div className="terminal-workspace">
      <div className="terminal-commandbar">
        <div className="terminal-command-list" aria-label="已保存的终端命令组">
          {commandGroups.map(group => (
            <div className="terminal-command-item" key={group.id}>
              <button
                type="button"
                className="terminal-command-chip"
                onClick={() => void runCommandGroup(group)}
                disabled={runningCommandId === group.id}
                title={`新建终端并执行：\n${group.commands.join("\n")}`}
              >
                <span className="terminal-command-name">{group.name}</span>
                <span className="terminal-command-count">{group.commands.length} 条</span>
              </button>
              <button type="button" className="terminal-command-edit" onClick={() => openCommandDialog(group)} title={`编辑 ${group.name}`} aria-label={`编辑 ${group.name}`}>
                <Icon name="edit" />
              </button>
              <button type="button" className="terminal-command-delete" onClick={() => void deleteCommandGroup(group)} title={`删除 ${group.name}`} aria-label={`删除 ${group.name}`}>
                <Icon name="close" />
              </button>
            </div>
          ))}
          {commandsLoaded && !commandGroups.length ? <span className="terminal-command-empty">尚无命令组</span> : null}
        </div>
        <span className={`terminal-storage-status${commandError ? " is-error" : ""}`}>{storageStatus}</span>
        {recording ? (
          <span className="terminal-recording-status">
            <span className="terminal-recording-dot" aria-hidden="true" />
            正在录制 {recordedCommands.length} 条
            <button type="button" className="terminal-recording-finish" onClick={finishRecording}>完成</button>
          </span>
        ) : null}
        <button type="button" className="terminal-command-new" onClick={() => openCommandDialog()} title="新建命令组">
          <Icon name="plus" />
          新建
        </button>
      </div>
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
          <TerminalView key={session.id} sessionId={session.id} active={session.id === activeId} onEnded={onEnded} onActivity={onActivity} onStatus={onStatus} onInput={onTerminalInput} />
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

      {commandDialogOpen ? createPortal(
        <div
          className="terminal-command-backdrop"
          onMouseDown={event => { if (event.target === event.currentTarget) closeCommandDialog(); }}
        >
          <section className="terminal-command-dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-command-dialog-title">
            <header className="terminal-command-dialog-header">
              <div>
                <p className="terminal-command-dialog-kicker">Terminal Quick Commands</p>
                <h2 id="terminal-command-dialog-title">{commandEditingId ? "编辑命令组" : "新建命令组"}</h2>
              </div>
              <button type="button" className="terminal-command-dialog-close" onClick={closeCommandDialog} aria-label="关闭">
                <Icon name="close" />
              </button>
            </header>
            <label className="field">
              <span className="field-label">名称</span>
              <input value={commandName} maxLength={40} autoFocus onChange={event => setCommandName(event.target.value)} placeholder="例如：构建前端" />
            </label>
            <label className="field">
              <span className="field-label">命令（每行一条）</span>
              <textarea value={commandText} rows={8} onChange={event => setCommandText(event.target.value)} placeholder={"npm run typecheck\nnpm run build"} />
            </label>
            <div className="terminal-command-recording-hint">
              录制会捕获当前终端中按回车提交的输入；方向键 / 快捷键不会记录。开始后配置框自动收起，可在顶部横条点「完成」回填并核对。
            </div>
            {commandFormError ? <p className="terminal-command-dialog-error" role="alert">{commandFormError}</p> : null}
            <footer className="terminal-command-dialog-actions">
              <Button variant="secondary" onClick={startRecording}>开始录制</Button>
              <Button variant="quiet" onClick={closeCommandDialog}>取消</Button>
              <Button onClick={() => void saveCommandGroup()} disabled={commandSaving}>{commandSaving ? "保存中…" : "保存"}</Button>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
