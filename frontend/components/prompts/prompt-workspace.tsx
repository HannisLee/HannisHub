"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatDate, truncate } from "../../lib/format";
import type { VoiceInsertMode } from "../../lib/prompt-audio";
import type {
  PromptItem,
  PromptPolishLevel,
  PromptPolishPrompts,
  PromptPolishResult,
  PromptPolishSettings,
  PromptReasoningEffort,
} from "../../lib/types";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingState } from "../ui/primitives";
import { VoiceInput } from "./voice-input";
import { VoiceSettings } from "./voice-settings";

const DRAFT_KEY = "hannishub_prompt_draft";
const LEGACY_DRAFT_KEY = "llamamanager_prompt_draft";

const POLISH_LEVELS: Array<{ id: PromptPolishLevel; label: string }> = [
  { id: "light", label: "轻度" },
  { id: "standard", label: "中度" },
  { id: "deep", label: "重度" },
];

const REASONING_EFFORT_LEVELS: Array<{ id: PromptReasoningEffort; label: string; description: string }> = [
  { id: "auto", label: "模型默认", description: "不传推理参数，由当前模型自行决定" },
  { id: "low", label: "低", description: "尽量减少思考，速度通常最快" },
  { id: "medium", label: "中", description: "在速度与推理质量之间折中" },
  { id: "high", label: "高", description: "允许更充分思考，速度可能较慢" },
];

const EMPTY_POLISH_PROMPTS: PromptPolishPrompts = { light: "", standard: "", deep: "" };

interface Draft {
  raw: string;
  polished: string;
  mode: "raw" | "polished";
  stale: boolean;
  restoredId?: string | null;
}

export function PromptWorkspace() {
  const [raw, setRaw] = useState("");
  const [polished, setPolished] = useState("");
  const [mode, setMode] = useState<"raw" | "polished">("raw");
  const [stale, setStale] = useState(true);
  const [restoredId, setRestoredId] = useState<string | null>(null);
  const [items, setItems] = useState<PromptItem[]>([]);
  const [polishPrompts, setPolishPrompts] = useState<PromptPolishPrompts>(EMPTY_POLISH_PROMPTS);
  const [defaultPolishPrompts, setDefaultPolishPrompts] = useState<PromptPolishPrompts>(EMPTY_POLISH_PROMPTS);
  const [reasoningEffort, setReasoningEffort] = useState<PromptReasoningEffort>("auto");
  const [loading, setLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [polishing, setPolishing] = useState<PromptPolishLevel | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [audioArchiveTarget, setAudioArchiveTarget] = useState<HTMLDivElement | null>(null);
  const [voiceFeedbackTarget, setVoiceFeedbackTarget] = useState<HTMLDivElement | null>(null);
  const [favoriteSavingId, setFavoriteSavingId] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const archiveInFlightRef = useRef(false);
  const messageTokenRef = useRef(0);
  const polishTokenRef = useRef(0);

  const currentValue = mode === "polished" ? polished : raw;
  const currentValueRef = useRef(currentValue);
  useLayoutEffect(() => { currentValueRef.current = currentValue; }, [currentValue]);
  const busy = !draftReady || archiving || polishing !== null || voiceRecording;

  const replaceVoiceText = useCallback((text: string, insertMode: VoiceInsertMode = "replace") => {
    // 使用当前显示的文本追加，并立即保存；同批返回多条录音也不会互相覆盖。
    const current = currentValueRef.current;
    const content = insertMode === "append" && current ? `${current}${current.endsWith("\n") ? "" : "\n"}${text}` : text;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ raw: content, polished: "", mode: "raw", stale: true, restoredId: null }));
    currentValueRef.current = content;
    setRaw(content);
    setPolished("");
    setMode("raw");
    setStale(true);
    setRestoredId(null);
    polishTokenRef.current += 1;
    setMessage(insertMode === "append" ? "语音已追加到当前提示词" : "语音已转写到当前提示词");
  }, []);

  const restoreVoiceText = useCallback((text: string) => {
    replaceVoiceText(text);
    setMessage("已恢复到编辑器");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [replaceVoiceText]);

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
      setReasoningEffort(data.reasoning_effort || "auto");
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
      setDraftReady(true);
      if (!stored) return;
      try {
        const draft = JSON.parse(stored) as Partial<Draft>;
        if (typeof draft.raw === "string") {
          setRaw(draft.raw);
          setPolished(draft.polished || "");
          setMode(draft.mode === "polished" ? "polished" : "raw");
          setStale(draft.stale !== false);
          setRestoredId(typeof draft.restoredId === "string" ? draft.restoredId : null);
        }
      } catch {
        setRaw(stored);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadArchive, loadPolishSettings]);

  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ raw, polished, mode, stale, restoredId } satisfies Draft));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [raw, polished, mode, stale, restoredId, draftReady]);

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
    const source = raw;
    if (!source.trim()) {
      setMessage("请先输入需要润色的原文");
      return;
    }
    const requestToken = ++polishTokenRef.current;
    setPolishing(level);
    setError("");
    setMessage(`${POLISH_LEVELS.find(item => item.id === level)?.label}处理中…`);
    try {
      const result = await apiFetch<PromptPolishResult>(`${API_PATHS.prompts}/polish`, {
        method: "POST",
        body: jsonBody({ content: source, level }),
      });
      if (requestToken !== polishTokenRef.current) return;
      if (!result.content?.trim()) throw new Error("模型未返回有效润色内容");
      setPolished(result.content);
      setMode("polished");
      setStale(false);
      const effortLabel = REASONING_EFFORT_LEVELS.find(item => item.id === result.reasoning_effort)?.label;
      setMessage(`润色完成 · ${result.model}${effortLabel ? ` · 推理 ${effortLabel}` : ""}`);
    } catch (value) {
      if (requestToken !== polishTokenRef.current) return;
      setError(errorMessage(value));
      setMessage("润色未完成，原文保持不变");
    } finally {
      if (requestToken === polishTokenRef.current) setPolishing(null);
    }
  }

  async function archive() {
    if (archiveInFlightRef.current) return;
    if (!currentValue.trim()) {
      setMessage("提示词为空，不能归档");
      return;
    }

    const content = currentValue;
    const polishedContent = mode === "polished" ? polished : "";
    const endpoint = restoredId
      ? `${API_PATHS.prompts}/prompts/${encodePath(restoredId)}`
      : `${API_PATHS.prompts}/prompts`;
    archiveInFlightRef.current = true;
    setArchiving(true);
    setError("");
    const showMessage = claimMessage();
    showMessage("正在归档…");

    try {
      await apiFetch(endpoint, {
        method: restoredId ? "PUT" : "POST",
        body: jsonBody({
          content,
          raw_content: raw,
          polished_content: polishedContent,
        }),
      });
      setRaw("");
      setPolished("");
      setStale(true);
      setMode("raw");
      setRestoredId(null);
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(LEGACY_DRAFT_KEY);
      showMessage(restoredId ? "已更新原归档记录" : "已归档");
      void loadArchive();
    } catch (value) {
      setError(errorMessage(value));
      showMessage(restoredId ? "归档记录更新失败，内容仍保留在编辑器" : "归档失败，内容仍保留在编辑器");
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

  async function toggleFavoritePrompt(item: PromptItem) {
    if (favoriteSavingId) return;
    const nextFavorite = !item.favorite;
    setFavoriteSavingId(item.id);
    setError("");
    try {
      await apiFetch(`${API_PATHS.prompts}/prompts/${encodePath(item.id)}/favorite`, {
        method: "PUT",
        body: jsonBody({ favorite: nextFavorite }),
      });
      await loadArchive();
      setMessage(nextFavorite ? "已收藏，归档已置顶" : "已取消收藏");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setFavoriteSavingId(null);
    }
  }

  function restorePrompt(item: PromptItem) {
    const rawContent = item.raw_content || item.content;
    setRaw(rawContent);
    setPolished(item.polished_content || "");
    setStale(!item.polished_content);
    setMode("raw");
    setRestoredId(item.id);
    setMessage("已恢复到编辑器");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function savePolishSettings() {
    setSettingsSaving(true);
    setError("");
    try {
      const data = await apiFetch<PromptPolishSettings>(`${API_PATHS.prompts}/polish-settings`, {
        method: "PUT",
        body: jsonBody({ prompts: polishPrompts, reasoning_effort: reasoningEffort }),
      });
      setPolishPrompts(data.prompts);
      setDefaultPolishPrompts(data.defaults);
      setReasoningEffort(data.reasoning_effort || "auto");
      setMessage("三档润色提示词与推理强度已保存");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSettingsSaving(false);
    }
  }

  return (
    <div className="prompt-workspace">
      <div className="prompt-workspace-heading">
        <h1 className="prompt-workspace-title">提示词</h1>
        <span className="prompt-workspace-status" role="status" title={voiceStatus || message}>{voiceStatus || message}</span>
      </div>
      {error ? <ErrorState message={error} /> : null}

      <Card className="prompt-editor-card">
        <CardHeader
          title="当前提示词"
          titleActions={<VoiceInput disabled={busy} onText={replaceVoiceText} onRestore={restoreVoiceText} onRecordingChange={setVoiceRecording} onStatusChange={setVoiceStatus} archiveTarget={audioArchiveTarget} feedbackTarget={voiceFeedbackTarget} />}
          actions={
            <div className="editor-actions">
              <div className="prompt-polish-actions" aria-label="润色强度">
                {POLISH_LEVELS.map(level => (
                  <button
                    className={`prompt-polish-button prompt-polish-${level.id}`}
                    type="button"
                    onClick={() => void runPolish(level.id)}
                    disabled={busy || !raw.trim()}
                    key={level.id}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
              <div className="segmented" role="tablist" aria-label="文本模式">
                <button type="button" role="tab" aria-selected={mode === "raw"} onClick={() => setMode("raw")} disabled={busy}>原文</button>
                <button type="button" role="tab" aria-selected={mode === "polished"} onClick={() => setMode("polished")} disabled={busy || !polished}>润色稿</button>
              </div>
              <Button variant="secondary" size="sm" onClick={() => copyText(currentValue, mode === "polished" ? "润色稿已复制" : "原文已复制")} disabled={busy}>复制</Button>
              <Button size="sm" onClick={() => void archive()} disabled={busy}>归档</Button>
            </div>
          }
        />
        <div ref={setVoiceFeedbackTarget} />
        <textarea
          className="prompt-editor"
          value={currentValue}
          onChange={event => {
            if (mode === "polished") {
              setPolished(event.target.value);
              return;
            }
            setRaw(event.target.value);
            setPolished("");
            setMode("raw");
            setStale(true);
            polishTokenRef.current += 1;
          }}
          placeholder="在这里输入或粘贴你的提示词…"
          spellCheck={false}
          disabled={busy}
        />
        <div className="editor-meta">
          <span>{currentValue.length.toLocaleString("zh-CN")} 字符</span>
          <span>{mode === "polished" ? "正在编辑润色稿" : "三档润色始终基于原文"}</span>
          <span>自动暂存</span>
        </div>
      </Card>

      <div className="prompt-layout">
          <Card className="prompt-archive-card">
            <CardHeader
              title={`归档列表 · ${items.length}`}
              description="收藏项置顶，其余按时间倒序展示；固定高度内滚动。"
          />
          {loading ? <LoadingState /> : items.length ? (
            <div className="prompt-archive-list">
              {items.map(item => (
                <details className="prompt-item" key={item.id}>
                  <summary>
                    <span className="prompt-item-copy">
                      <small className="prompt-item-meta">{formatDate(item.updated_at)} · {item.content.length.toLocaleString("zh-CN")} 字符</small>
                      <strong className="prompt-item-title">{truncate(item.content.split(/\r?\n/).find(line => line.trim()) || item.content, 100)}</strong>
                    </span>
                    <span className="prompt-item-actions" onClick={event => event.stopPropagation()}>
                      {item.favorite ? (
                        <Button size="sm" variant="secondary" type="button" onClick={() => restorePrompt(item)}>恢复</Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        className={item.favorite ? "prompt-favorite-active" : ""}
                        type="button"
                        aria-pressed={item.favorite}
                        disabled={!!favoriteSavingId}
                        aria-busy={favoriteSavingId === item.id}
                        title={item.favorite ? "取消收藏，恢复按时间排列" : "收藏后置顶显示"}
                        onClick={() => void toggleFavoritePrompt(item)}
                      >
                        {item.favorite ? "已收藏" : "收藏"}
                      </Button>
                    </span>
                    <span className="prompt-item-chevron" aria-hidden="true">⌄</span>
                  </summary>
                  <div className="prompt-item-body">
                    <pre>{item.content}</pre>
                    <div className="row-actions">
                      <Button size="sm" variant="secondary" type="button" onClick={() => copyText(item.content, "归档提示词已复制")}>复制</Button>
                      <Button size="sm" variant="quiet" type="button" onClick={() => restorePrompt(item)}>恢复</Button>
                      <Button size="sm" variant="danger" type="button" onClick={() => void removePrompt(item)}>删除</Button>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          ) : <EmptyState title="暂无归档提示词" detail="归档内容会按时间顺序出现在这里。" />}
        </Card>
      </div>

      <div ref={setAudioArchiveTarget} />

      <Card className="prompt-settings-card">
        <CardHeader
          title="润色提示词设置"
          description="分别控制轻度、标准和深度三档。API 地址、密钥和模型继续使用 AI 能力设置中的当前配置。"
          actions={
            <div className="row-actions">
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setPolishPrompts({ ...defaultPolishPrompts });
                  setReasoningEffort("auto");
                  setMessage("已恢复默认内容与推理强度，保存后生效");
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
          <>
            <div className="prompt-reasoning-setting">
              <label className="prompt-reasoning-field">
                <span><strong>推理强度</strong></span>
                <select
                  value={reasoningEffort}
                  onChange={event => setReasoningEffort(event.target.value as PromptReasoningEffort)}
                  disabled={settingsSaving}
                >
                  {REASONING_EFFORT_LEVELS.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
                </select>
              </label>
              <small>{REASONING_EFFORT_LEVELS.find(item => item.id === reasoningEffort)?.description}</small>
            </div>
            <div className="prompt-settings-grid">
              {POLISH_LEVELS.map(level => (
                <label className="prompt-settings-field" key={level.id}>
                  <span><strong>{level.label}</strong></span>
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
          </>
        )}
      </Card>
      <VoiceSettings />
    </div>
  );
}
