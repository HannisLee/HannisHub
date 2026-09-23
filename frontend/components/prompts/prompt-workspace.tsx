"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatDate, truncate } from "../../lib/format";
import type { PromptGroup, PromptItem } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState } from "../ui/primitives";

const DRAFT_KEY = "hannishub_prompt_draft";
const LEGACY_DRAFT_KEY = "llamamanager_prompt_draft";

interface Draft {
  raw: string;
  polished: string;
  mode: "raw" | "polished";
  stale: boolean;
  group: string;
}

function polishText(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let inFence = false;
  let blankPending = false;
  const pushBlank = () => {
    if (blankPending && output.length) output.push("");
    blankPending = false;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      pushBlank();
      inFence = !inFence;
      output.push(rawLine.replace(/[ \t]+$/, ""));
      continue;
    }
    if (inFence) {
      output.push(rawLine);
      continue;
    }
    let line = rawLine.replace(/\u3000/g, " ").replace(/[ \t]+$/, "");
    if (!line.trim()) {
      blankPending = true;
      continue;
    }
    line = line
      .replace(/^(#{1,6})(?!#)(?![ \t])/, "$1 ")
      .replace(/^(\s*)[*•·●▪]\s+/, "$1- ")
      .replace(/^(\s*)(\d+)[、）)]\s*/, "$1$2. ");
    pushBlank();
    output.push(line);
  }
  while (output.length && !output[0].trim()) output.shift();
  while (output.length && !output[output.length - 1].trim()) output.pop();
  return output.join("\n");
}

export function PromptWorkspace() {
  const [raw, setRaw] = useState("");
  const [polished, setPolished] = useState("");
  const [mode, setMode] = useState<"raw" | "polished">("raw");
  const [stale, setStale] = useState(true);
  const [groups, setGroups] = useState<PromptGroup[]>([]);
  const [items, setItems] = useState<PromptItem[]>([]);
  const [activeGroup, setActiveGroup] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const currentValue = mode === "polished" ? polished : raw;
  const sections = useMemo(() => [{ id: "", name: "无分组" }, ...groups], [groups]);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ prompts: PromptItem[]; groups: PromptGroup[] }>(`${API_PATHS.prompts}/prompts`);
      setItems(data.prompts || []);
      setGroups(data.groups || []);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
      const stored = localStorage.getItem(DRAFT_KEY) || localStorage.getItem(LEGACY_DRAFT_KEY);
      if (!stored) return;
      try {
        const draft = JSON.parse(stored) as Partial<Draft>;
        if (typeof draft.raw === "string") {
          setRaw(draft.raw);
          setPolished(draft.polished || "");
          setMode(draft.mode === "polished" ? "polished" : "raw");
          setStale(draft.stale !== false);
          setActiveGroup(draft.group || "");
        }
      } catch {
        setRaw(stored);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ raw, polished, mode, stale, group: activeGroup } satisfies Draft));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [raw, polished, mode, stale, activeGroup]);

  function groupName(id: string): string {
    return id ? groups.find(group => group.id === id)?.name || "已删除分组" : "无分组";
  }

  function switchMode(next: "raw" | "polished") {
    if (next === "polished" && (stale || !polished)) {
      setPolished(polishText(raw));
      setStale(false);
    }
    setMode(next);
  }

  async function copyText(value: string, success: string) {
    if (!value.trim()) {
      setMessage("当前提示词为空");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setMessage(success);
    } catch {
      setMessage("复制失败，请手动选择文本");
    }
  }

  async function archive() {
    if (!currentValue.trim()) {
      setMessage("提示词为空，不能归档");
      return;
    }
    try {
      await apiFetch(`${API_PATHS.prompts}/prompts`, {
        method: "POST",
        body: jsonBody({ content: currentValue, group_id: activeGroup }),
      });
      setRaw("");
      setPolished("");
      setStale(true);
      setMode("raw");
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(LEGACY_DRAFT_KEY);
      setMessage(`已归档到「${groupName(activeGroup)}」`);
      await load();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newGroup.trim();
    if (!name) return;
    try {
      const group = await apiFetch<PromptGroup>(`${API_PATHS.prompts}/groups`, {
        method: "POST",
        body: jsonBody({ name }),
      });
      setNewGroup("");
      setActiveGroup(group.id);
      setMessage(`已创建分组「${group.name}」`);
      await load();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function renameGroup(group: PromptGroup) {
    const name = window.prompt("请输入新的分组名称", group.name)?.trim();
    if (!name || name === group.name) return;
    try {
      await apiFetch(`${API_PATHS.prompts}/groups/${encodePath(group.id)}`, { method: "PUT", body: jsonBody({ name }) });
      await load();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function deleteGroup(group: PromptGroup) {
    if (!window.confirm(`删除分组「${group.name}」？组内提示词会移动到无分组。`)) return;
    try {
      await apiFetch(`${API_PATHS.prompts}/groups/${encodePath(group.id)}`, { method: "DELETE" });
      if (activeGroup === group.id) setActiveGroup("");
      await load();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function reorder(groupId: string, direction: -1 | 1) {
    const index = groups.findIndex(group => group.id === groupId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= groups.length) return;
    const order = groups.map(group => group.id);
    [order[index], order[next]] = [order[next], order[index]];
    try {
      const data = await apiFetch<{ groups: PromptGroup[] }>(`${API_PATHS.prompts}/groups/order`, {
        method: "PUT",
        body: jsonBody({ order }),
      });
      setGroups(data.groups || groups);
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function movePrompt(item: PromptItem, groupId: string) {
    try {
      await apiFetch(`${API_PATHS.prompts}/prompts/${encodePath(item.id)}`, {
        method: "PUT",
        body: jsonBody({ group_id: groupId }),
      });
      await load();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function removePrompt(item: PromptItem) {
    if (!window.confirm("确定删除这条归档提示词吗？")) return;
    try {
      await apiFetch(`${API_PATHS.prompts}/prompts/${encodePath(item.id)}`, { method: "DELETE" });
      await load();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  return (
    <div className="prompt-workspace">
      <h1 className="prompt-workspace-title">提示词 / Workspace</h1>
      {error ? <ErrorState message={error} /> : null}
      {message ? <div className="inline-message">{message}</div> : null}
      <Card className="prompt-editor-card">
        <CardHeader
          title="当前提示词"
          actions={<div className="editor-actions"><div className="segmented" role="tablist" aria-label="文本模式"><button type="button" role="tab" aria-selected={mode === "raw"} onClick={() => switchMode("raw")}>原文</button><button type="button" role="tab" aria-selected={mode === "polished"} onClick={() => switchMode("polished")}>润色</button></div><Button variant="secondary" size="sm" onClick={() => void copyText(currentValue, mode === "polished" ? "润色稿已复制" : "原文已复制")}>复制</Button><Button size="sm" onClick={() => void archive()}>归档</Button></div>}
        />
        <textarea className="prompt-editor" value={currentValue} onChange={event => mode === "polished" ? setPolished(event.target.value) : (setRaw(event.target.value), setStale(true))} placeholder="在这里输入或粘贴你的提示词…" spellCheck={false} />
        <div className="editor-meta"><span>{currentValue.length.toLocaleString("zh-CN")} 字符</span><span>归档到 <select value={activeGroup} onChange={event => setActiveGroup(event.target.value)}><option value="">无分组</option>{groups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select></span><span>自动暂存</span></div>
      </Card>
      <div className="prompt-layout">
        <Card>
          <CardHeader title={`归档列表 · ${items.length}`} description="点击条目展开内容，可移动分组或恢复到编辑器。" actions={<form className="inline-form" onSubmit={createGroup}><input value={newGroup} onChange={event => setNewGroup(event.target.value)} placeholder="新建分组" maxLength={40} /><Button size="sm" type="submit">创建</Button></form>} />
          {loading ? <LoadingState /> : <div className="prompt-groups">{sections.map((section, sectionIndex) => {
            const groupItems = items.filter(item => (item.group_id || "") === section.id);
            const group = groups.find(item => item.id === section.id);
            return <section className={`prompt-group${activeGroup === section.id ? " is-active" : ""}`} key={section.id || "ungrouped"}>
              <div className="prompt-group-head">
                <button className="group-select" type="button" onClick={() => setActiveGroup(section.id)}><span className="group-grip">⋮⋮</span><strong>{section.name}</strong><Badge>{groupItems.length}</Badge></button>
                {group ? <div className="row-actions"><Button variant="quiet" size="sm" onClick={() => void reorder(group.id, -1)} disabled={sectionIndex <= 1}>↑</Button><Button variant="quiet" size="sm" onClick={() => void reorder(group.id, 1)} disabled={sectionIndex >= groups.length}>↓</Button><Button variant="quiet" size="sm" onClick={() => void renameGroup(group)}>重命名</Button><Button variant="quiet" size="sm" onClick={() => void deleteGroup(group)}>删除</Button></div> : null}
              </div>
              <div className="prompt-items">
                {groupItems.length ? groupItems.map(item => <details className="prompt-item" key={item.id}><summary><span className="prompt-item-copy"><small>{formatDate(item.updated_at)} · {item.content.length.toLocaleString("zh-CN")} 字符</small><strong className="prompt-item-title">{truncate(item.content.split(/\r?\n/).find(line => line.trim()) || item.content, 80)}</strong></span><span>⌄</span></summary><div className="prompt-item-body"><pre>{item.content}</pre><div className="row-actions"><Button size="sm" variant="secondary" onClick={() => void copyText(item.content, "归档提示词已复制")}>复制</Button><Button size="sm" variant="quiet" onClick={() => { setRaw(item.content); setPolished(""); setStale(true); setMode("raw"); setMessage("已恢复到编辑器"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>恢复</Button><select className="select-compact" value={item.group_id || ""} onChange={event => void movePrompt(item, event.target.value)}><option value="">无分组</option>{groups.map(option => <option value={option.id} key={option.id}>{option.name}</option>)}</select><Button size="sm" variant="danger" onClick={() => void removePrompt(item)}>删除</Button></div></div></details>) : <EmptyState title="暂无归档提示词" detail={section.id ? "可以把条目移动到这个分组。" : "归档内容会出现在这里。"} />}
              </div>
            </section>;
          })}</div>}
        </Card>
      </div>
    </div>
  );
}
