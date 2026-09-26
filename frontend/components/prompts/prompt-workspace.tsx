"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatDate, truncate } from "../../lib/format";
import type {
  PromptItem,
  PromptPolishLevel,
  PromptPolishPrompts,
  PromptPolishResult,
  PromptPolishSettings,
} from "../../lib/types";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingState } from "../ui/primitives";

const DRAFT_KEY = "hannishub_prompt_draft";
const LEGACY_DRAFT_KEY = "llamamanager_prompt_draft";
const ARCHIVE_MAX_COUNT = 500;

const POLISH_LEVELS: Array<{ id: PromptPolishLevel; label: string; detail: string }> = [
  { id: "light", label: "轻度润色", detail: "修正表达，尽量保留原文" },
  { id: "standard", label: "标准润色", detail: "梳理结构、目标与约束" },
  { id: "deep", label: "深度润色", detail: "重构为工程化高质量提示词" },
];

const EMPTY_POLISH_PROMPTS: PromptPolishPrompts = { light: "", standard: "", deep: "" };

interface Draft {
  raw: string;
  polished: string;
  mode: "raw" | "polished";
  stale: boolean;
}

export function PromptWorkspace() {
  const [raw, setRaw] = useState("");
  const [polished, setPolished] = useState("");
  const [mode, setMode] = useState<"raw" | "polished">("raw");
  const [stale, setStale] = useState(true);
  const [items, setItems] = useState<PromptItem[]>([]);
  const [polishPrompts, setPolishPrompts] = useState<PromptPolishPrompts>(EMPTY_POLISH_PROMPTS);
  const [defaultPolishPrompts, setDefaultPolishPrompts] = useState<PromptPolishPrompts>(EMPTY_POLISH_PROMPTS);
  const [loading, setLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [polishing, setPolishing] = useState<PromptPolishLevel | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const archiveInFlightRef = useRef(false);
  const messageTokenRef = useRef(0);

  const currentValue = mode === "polished" ? polished : raw;
  const busy = archiving || polishing !== null;

  const loadArchive = useCallback(async () => {
    try {
      const data = await apiFetch<{ prompts: PromptItem[] }>(`${API_PATHS.prompts}/prompts`);
      setItems(data.prompts || []);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPolishSettings = useCallback(async () => {
    try {
      const data = await apiFetch<PromptPolishSettings>(`${API_PATHS.prompts}/polish-settings`);
      setPolishPrompts(data.prompts);
      setDefaultPolishPrompts(data.defaults);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadArchive();
      void loadPolishSettings();
      const stored = localStorage.getItem(DRAFT_KEY) || localStorage.getItem(LEGACY_DRAFT_KEY);
      if (!stored) return;
      try {
        const draft = JSON.parse(stored) as Partial<Draft>;
        if (typeof draft.raw === "string") {
          setRaw(draft.raw);
          setPolished(draft.polished || "");
          setMode(draft.mode === "polished" ? "polished" : "raw");
          setStale(draft.stale !== false);
        }
      } catch {
        setRaw(stored);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadArchive, loadPolishSettings]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ raw, polished, mode, stale } satisfies Draft));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [raw, polished, mode, stale]);

  function claimMessage() {
    const token = ++messageTokenRef.current;
    return (value: string) => {
      if (messageTokenRef.current === token) setMessage(value);
    };
  }

  function legacyCopyText(value: string): boolean {
    // 非安全上下文（例如通过 HTTP IP 访问）可能没有异步 Clipboard API，使用同步复制兜底。
    const textarea = document.createElement("textarea");
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    previousActive?.focus();
    textarea.remove();
    return copied;
  }

  function copyToClipboard(value: string): Promise<boolean> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(value).then(() => true).catch(() => false);
    }
    return Promise.resolve(legacyCopyText(value));
  }

  function copyText(value: string, success: string) {
    if (!value.trim()) {
      setMessage("当前提示词为空");
      return;
    }
    const showMessage = claimMessage();
    showMessage(success);
    void copyToClipboard(value).then(copied => {
      if (!copied) showMessage("复制失败，请手动选择文本");
    });
  }

  async function runPolish(level: PromptPolishLevel) {
    if (!raw.trim()) {
      setMessage("请先输入需要润色的原文");
      return;
    }
    setPolishing(level);
    setError("");
    setMessage(`${POLISH_LEVELS.find(item => item.id === level)?.label}处理中…`);
    try {
      const result = await apiFetch<PromptPolishResult>(`${API_PATHS.prompts}/polish`, {
        method: "POST",
        body: jsonBody({ content: raw, level }),
      });
      setPolished(result.content);
      setMode("polished");
      setStale(false);
      setMessage(`润色完成 · ${result.model}`);
    } catch (value) {
      setError(errorMessage(value));
      setMessage("润色未完成，原文保持不变");
    } finally {
      setPolishing(null);
    }
  }

  async function archive() {
    if (archiveInFlightRef.current) return;
    if (!currentValue.trim()) {
      setMessage("提示词为空，不能归档");
      return;
    }

    const content = currentValue;
    archiveInFlightRef.current = true;
    setArchiving(true);
    setError("");
    const showMessage = claimMessage();
    showMessage("已复制，正在归档…");
    let copied: boolean | null = null;
    let archiveFinished = false;
    let archiveSucceeded = false;
    void copyToClipboard(content).then(result => {
      copied = result;
      if (result) return;
      if (!archiveFinished) {
        showMessage("复制失败，归档仍在进行…");
        return;
      }
      showMessage(archiveSucceeded ? "已归档，但复制失败，请手动复制" : "复制与归档均失败，内容仍保留在编辑器");
    });

    try {
      await apiFetch(`${API_PATHS.prompts}/prompts`, {
        method: "POST",
        body: jsonBody({ content }),
      });
      archiveFinished = true;
      archiveSucceeded = true;
      setRaw("");
      setPolished("");
      setStale(true);
      setMode("raw");
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(LEGACY_DRAFT_KEY);
      showMessage(copied === false ? "已归档，但复制失败，请手动复制" : "已复制并归档");
      void loadArchive();
    } catch (value) {
      archiveFinished = true;
      archiveSucceeded = false;
      setError(errorMessage(value));
      showMessage(copied === false ? "复制与归档均失败，内容仍保留在编辑器" : "已复制，但归档失败，内容仍保留在编辑器");
    } finally {
      archiveInFlightRef.current = false;
      setArchiving(false);
    }
  }

  async function removePrompt(item: PromptItem) {
    if (!window.confirm("确定删除这条归档提示词吗？")) return;
    try {
      await apiFetch(`${API_PATHS.prompts}/prompts/${encodePath(item.id)}`, { method: "DELETE" });
      await loadArchive();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  function restorePrompt(item: PromptItem) {
    setRaw(item.content);
    setPolished("");
    setStale(true);
    setMode("raw");
    setMessage("已恢复到编辑器");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function savePolishSettings() {
    setSettingsSaving(true);
    setError("");
    try {
      const data = await apiFetch<PromptPolishSettings>(`${API_PATHS.prompts}/polish-settings`, {
        method: "PUT",
        body: jsonBody({ prompts: polishPrompts }),
      });
      setPolishPrompts(data.prompts);
      setDefaultPolishPrompts(data.defaults);
      setMessage("三档润色提示词已保存");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSettingsSaving(false);
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
          description={stale && polished ? "原文已修改，润色稿可能不是最新版本。" : "三档润色均使用项目设置中已保存的 AI 模型。"}
          actions={
            <div className="editor-actions">
              <div className="segmented" role="tablist" aria-label="文本模式">
                <button type="button" role="tab" aria-selected={mode === "raw"} onClick={() => setMode("raw")} disabled={busy}>原文</button>
                <button type="button" role="tab" aria-selected={mode === "polished"} onClick={() => setMode("polished")} disabled={busy || !polished}>润色稿</button>
              </div>
              <Button variant="secondary" size="sm" onClick={() => copyText(currentValue, mode === "polished" ? "润色稿已复制" : "原文已复制")} disabled={busy}>复制</Button>
              <Button size="sm" onClick={() => void archive()} disabled={busy}>{archiving ? "归档中…" : "归档并复制"}</Button>
            </div>
          }
        />
        <textarea
          className="prompt-editor"
          value={currentValue}
          onChange={event => {
            if (mode === "polished") {
              setPolished(event.target.value);
              return;
            }
            setRaw(event.target.value);
            setStale(true);
          }}
          placeholder="在这里输入或粘贴你的提示词…"
          spellCheck={false}
          disabled={busy}
        />
        <div className="prompt-polish-actions" aria-label="润色强度">
          {POLISH_LEVELS.map(level => (
            <button
              className={`prompt-polish-button prompt-polish-${level.id}`}
              type="button"
              onClick={() => void runPolish(level.id)}
              disabled={busy || !raw.trim()}
              key={level.id}
            >
              <span>{polishing === level.id ? "处理中…" : level.label}</span>
              <small>{level.detail}</small>
            </button>
          ))}
        </div>
        <div className="editor-meta">
          <span>{currentValue.length.toLocaleString("zh-CN")} 字符</span>
          <span>{mode === "polished" ? "正在编辑润色稿" : "三档润色始终基于原文"}</span>
          <span>自动暂存</span>
        </div>
      </Card>

      <div className="prompt-layout">
        <Card className="prompt-archive-card">
          <CardHeader
            title={`归档列表 · ${items.length}/${ARCHIVE_MAX_COUNT}`}
            description="按时间倒序排列；列表固定高度并独立滚动，超过 500 条时自动淘汰最早记录。"
          />
          {loading ? <LoadingState /> : items.length ? (
            <div className="prompt-archive-list">
              {items.map(item => (
                <details className="prompt-item" key={item.id}>
                  <summary>
                    <span className="prompt-item-copy">
                      <small>{formatDate(item.updated_at)} · {item.content.length.toLocaleString("zh-CN")} 字符</small>
                      <strong className="prompt-item-title">{truncate(item.content.split(/\r?\n/).find(line => line.trim()) || item.content, 100)}</strong>
                    </span>
                    <span className="prompt-item-chevron" aria-hidden="true">⌄</span>
                  </summary>
                  <div className="prompt-item-body">
                    <pre>{item.content}</pre>
                    <div className="row-actions">
                      <Button size="sm" variant="secondary" onClick={() => copyText(item.content, "归档提示词已复制")}>复制</Button>
                      <Button size="sm" variant="quiet" onClick={() => restorePrompt(item)}>恢复</Button>
                      <Button size="sm" variant="danger" onClick={() => void removePrompt(item)}>删除</Button>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          ) : <EmptyState title="暂无归档提示词" detail="归档内容会按时间顺序出现在这里。" />}
        </Card>
      </div>

      <Card className="prompt-settings-card">
        <CardHeader
          title="润色提示词设置"
          description="分别控制轻度、标准和深度三档。API 地址、密钥和模型继续使用项目设置中的统一配置。"
          actions={
            <div className="row-actions">
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setPolishPrompts({ ...defaultPolishPrompts });
                  setMessage("已恢复默认内容，保存后生效");
                }}
                disabled={settingsLoading || settingsSaving || !defaultPolishPrompts.light}
              >恢复默认</Button>
              <Button size="sm" onClick={() => void savePolishSettings()} disabled={settingsLoading || settingsSaving}>
                {settingsSaving ? "保存中…" : "保存设置"}
              </Button>
            </div>
          }
        />
        {settingsLoading ? <LoadingState /> : (
          <div className="prompt-settings-grid">
            {POLISH_LEVELS.map(level => (
              <label className="prompt-settings-field" key={level.id}>
                <span><strong>{level.label}</strong><small>{level.detail}</small></span>
                <textarea
                  value={polishPrompts[level.id]}
                  onChange={event => setPolishPrompts(current => ({ ...current, [level.id]: event.target.value }))}
                  maxLength={8000}
                  spellCheck={false}
                  disabled={settingsSaving}
                />
              </label>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
