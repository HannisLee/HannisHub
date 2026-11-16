"use client";

import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  deleteFeatureRequest, fetchFeatureRequests, FEATURE_STATUS_LABELS, FEATURE_STATUSES, FEATURE_TEXT_MAX,
  postFeatureRequest, setFeatureStatus, type FeatureRequest, type FeatureStatus,
} from "../../../lib/feature-requests";
import { errorMessage } from "../../../lib/format";
import { Button, EmptyState, ErrorState, LoadingState } from "../../ui/primitives";
import { formatChatTime } from "../shared/chat-avatar";

const OPEN_KEY = "hannishub_feature_board_open";
const STATUS_TONE: Record<FeatureStatus, string> = {
  open: "", accepted: "badge-info", done: "badge-success", declined: "",
};

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** 展开状态：写入本浏览器存储并通知订阅者；存储不可用时退回内存值 */
let memoryOpen: boolean | null = null;
const listeners = new Set<() => void>();

function readSnapshot(): boolean {
  return memoryOpen ?? readOpen();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function writeOpen(open: boolean) {
  memoryOpen = open;
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // 浏览器禁用存储时只在本次页面内生效
  }
  listeners.forEach(listener => listener());
}

/** 聊天室右侧的功能改进建议板：默认收起为一条竖向标签，点开后可写建议并查看所有人的建议；
 *  自己提的可以删除，管理员可以修改状态、删除任何一条。展开状态记在本浏览器。 */
export function FeatureBoard() {
  const open = useSyncExternalStore(subscribe, readSnapshot, () => false);
  const [items, setItems] = useState<FeatureRequest[] | null>(null);
  const [moderate, setModerate] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(() => {
    fetchFeatureRequests()
      .then(state => {
        setItems(state.items);
        setModerate(state.can_moderate);
        setError("");
      })
      .catch(value => {
        setError(errorMessage(value));
        setItems(current => current ?? []);
      });
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  function toggle(next: boolean) {
    writeOpen(next);
    if (next) load();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = text.trim();
    if (!content || posting) return;
    setPosting(true);
    try {
      const item = await postFeatureRequest(content);
      setItems(current => [item, ...(current ?? []).filter(row => row.id !== item.id)]);
      setText("");
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setPosting(false);
    }
  }

  async function changeStatus(item: FeatureRequest, status: FeatureStatus) {
    try {
      const updated = await setFeatureStatus(item.id, status);
      setItems(current => current?.map(row => (row.id === updated.id ? updated : row)) ?? current);
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function remove(item: FeatureRequest) {
    if (!window.confirm(item.mine ? "删除这条建议？" : `删除 ${item.name} 的这条建议？`)) return;
    try {
      await deleteFeatureRequest(item.id);
      setItems(current => current?.filter(row => row.id !== item.id) ?? current);
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  const pendingCount = items?.filter(item => item.status === "open").length ?? 0;

  if (!open) {
    return (
      <button type="button" className="feature-tab" onClick={() => toggle(true)} aria-expanded={false} aria-controls="feature-board">
        <span className="feature-tab-label">功能改进建议</span>
        {pendingCount ? <span className="feature-tab-count">{pendingCount}</span> : null}
      </button>
    );
  }

  return (
    <aside className="feature-board" id="feature-board" aria-label="功能改进建议">
      <header className="feature-board-head">
        <div>
          <h2 className="feature-board-title">功能改进建议</h2>
          <p className="feature-board-hint">想要什么新功能、哪里不好用，写下来大家都能看到。</p>
        </div>
        <button type="button" className="feature-board-close" onClick={() => toggle(false)} aria-label="收起建议板" title="收起">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
        </button>
      </header>

      <form className="feature-compose" onSubmit={event => void submit(event)}>
        <textarea
          rows={4}
          value={text}
          maxLength={FEATURE_TEXT_MAX}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit(event);
          }}
          placeholder="描述你希望的改进：在哪个页面、想要什么效果……（Ctrl + Enter 提交）"
          aria-label="建议内容"
        />
        <div className="feature-compose-bar">
          <span className="feature-count">{text.length}/{FEATURE_TEXT_MAX}</span>
          <Button type="submit" size="sm" disabled={!text.trim() || posting}>{posting ? "提交中…" : "提交建议"}</Button>
        </div>
      </form>

      {error ? <ErrorState message={error} /> : null}

      <div className="feature-list-wrap">
        {items === null ? <LoadingState /> : items.length ? (
          <ul className="feature-list">
            {items.map(item => (
              <li key={item.id} className={`feature-item feature-${item.status}`}>
                <p className="feature-text">{item.text}</p>
                <div className="feature-foot">
                  {moderate ? (
                    <select
                      className="feature-status-select"
                      value={item.status}
                      onChange={event => void changeStatus(item, event.target.value as FeatureStatus)}
                      aria-label="建议状态"
                    >
                      {FEATURE_STATUSES.map(status => <option key={status} value={status}>{FEATURE_STATUS_LABELS[status]}</option>)}
                    </select>
                  ) : <span className={`badge ${STATUS_TONE[item.status]}`}>{FEATURE_STATUS_LABELS[item.status]}</span>}
                  <span className="feature-meta">{item.mine ? "我" : item.name} · {formatChatTime(item.created_at)}</span>
                  {item.mine || moderate ? (
                    <button type="button" className="feature-remove" onClick={() => void remove(item)} aria-label="删除这条建议" title="删除">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="还没有建议" detail="写下第一条吧。" />}
      </div>
    </aside>
  );
}
