"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { AiApiTarget, AiConnectionTestResult, AiModelTestResult, AiSettings } from "../../lib/types";
import { Badge, Button, Card, CardHeader, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

const EMPTY_SETTINGS: AiSettings = {
  openai_primary_api_base_url: "",
  openai_primary_api_model: "",
  openai_primary_api_key_configured: false,
  openai_backup_api_base_url: "",
  openai_backup_api_model: "",
  openai_backup_api_key_configured: false,
};

const API_DETAILS: Record<AiApiTarget, { title: string; description: string }> = {
  primary: {
    title: "主 API",
    description: "AI 任务会优先使用这里配置的地址与模型。旧版单 API 配置会自动迁移到此处。",
  },
  backup: {
    title: "备用 API",
    description: "主 API 连接失败、返回错误或没有有效内容时，系统会自动改用这里的地址与模型。",
  },
};

export function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettings>(EMPTY_SETTINGS);
  const [models, setModels] = useState<Record<AiApiTarget, string[]>>({ primary: [], backup: [] });
  const [apiKeys, setApiKeys] = useState<Record<AiApiTarget, string>>({ primary: "", backup: "" });
  const [clearKeys, setClearKeys] = useState<Record<AiApiTarget, boolean>>({ primary: false, backup: false });
  const [status, setStatus] = useState("");
  const [modelStatus, setModelStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState<AiApiTarget | "">("");
  const [discoveringModels, setDiscoveringModels] = useState<AiApiTarget | "">("");
  const [testingModel, setTestingModel] = useState<AiApiTarget | "">("");

  async function load() {
    try {
      setSettings(await apiFetch<AiSettings>(API_PATHS.aiSettings));
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function setBaseUrl(target: AiApiTarget, value: string) {
    setSettings(current => target === "primary"
      ? { ...current, openai_primary_api_base_url: value }
      : { ...current, openai_backup_api_base_url: value });
  }

  function setModel(target: AiApiTarget, value: string) {
    setSettings(current => target === "primary"
      ? { ...current, openai_primary_api_model: value }
      : { ...current, openai_backup_api_model: value });
    setModelStatus("");
    setError("");
  }

  function baseUrlFor(target: AiApiTarget) {
    return target === "primary" ? settings.openai_primary_api_base_url : settings.openai_backup_api_base_url;
  }

  function modelFor(target: AiApiTarget) {
    return target === "primary" ? settings.openai_primary_api_model : settings.openai_backup_api_model;
  }

  function keyConfiguredFor(target: AiApiTarget) {
    return target === "primary" ? settings.openai_primary_api_key_configured : settings.openai_backup_api_key_configured;
  }

  async function save() {
    setSaving(true);
    try {
      const data = await apiFetch<AiSettings>(API_PATHS.aiSettings, {
        method: "PUT",
        body: jsonBody({
          openai_primary_api_base_url: settings.openai_primary_api_base_url || "",
          openai_primary_api_model: settings.openai_primary_api_model || "",
          openai_primary_api_key: apiKeys.primary,
          clear_openai_primary_api_key: clearKeys.primary,
          openai_backup_api_base_url: settings.openai_backup_api_base_url || "",
          openai_backup_api_model: settings.openai_backup_api_model || "",
          openai_backup_api_key: apiKeys.backup,
          clear_openai_backup_api_key: clearKeys.backup,
        }),
      });
      setSettings(data);
      setApiKeys({ primary: "", backup: "" });
      setClearKeys({ primary: false, backup: false });
      setStatus("主 API 与备用 API 设置已保存到本机 ai_settings.json");
      setModelStatus("");
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSaving(false);
    }
  }

  async function discoverModelList(target: AiApiTarget) {
    setDiscoveringModels(target);
    try {
      const result = await apiFetch<AiConnectionTestResult>(`${API_PATHS.aiSettings}/models`, {
        method: "POST",
        body: jsonBody({ target }),
      });
      const discovered = result.models || [];
      setModels(current => ({ ...current, [target]: discovered }));
      setStatus(result.message || `${API_DETAILS[target].title}已发现 ${discovered.length} 个模型`);
      if (!modelFor(target).trim() && discovered.length) setModel(target, discovered[0]);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setDiscoveringModels("");
    }
  }

  async function testConnection(target: AiApiTarget) {
    setTestingConnection(target);
    try {
      const result = await apiFetch<AiConnectionTestResult>(`${API_PATHS.aiSettings}/test`, {
        method: "POST",
        body: jsonBody({ target }),
      });
      setModels(current => ({ ...current, [target]: result.models || [] }));
      setStatus(result.message || `${API_DETAILS[target].title}连接成功`);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setTestingConnection("");
    }
  }

  async function testCurrentModel(target: AiApiTarget) {
    const model = modelFor(target);
    if (!model.trim()) {
      setModelStatus("");
      setError(`请先为${API_DETAILS[target].title}选择或输入模型名称`);
      return;
    }
    setTestingModel(target);
    try {
      const result = await apiFetch<AiModelTestResult>(`${API_PATHS.aiSettings}/model-test`, {
        method: "POST",
        body: jsonBody({ target, model }),
      });
      setModelStatus(result.response ? `${result.message}：${result.response}` : result.message);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setTestingModel("");
    }
  }

  function renderApiConnectionCard(target: AiApiTarget) {
    const detail = API_DETAILS[target];
    const configured = keyConfiguredFor(target);
    const discoveredModels = models[target];
    const model = modelFor(target);
    return (
      <Card>
        <CardHeader title={detail.title} description={detail.description} />
        <div className="form-grid">
          <Field label="API 地址">
            <input
              type="url"
              value={baseUrlFor(target)}
              onChange={event => setBaseUrl(target, event.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </Field>
          <Field label="模型选择" hint="点击下方模型按钮会自动填入；也可以直接输入自定义模型名称">
            <input
              list={`ai-model-options-${target}`}
              value={model}
              onChange={event => setModel(target, event.target.value)}
              placeholder="先探查模型列表，或直接输入模型名"
            />
            <datalist id={`ai-model-options-${target}`}>
              {discoveredModels.map(item => <option value={item} key={item}>{item}</option>)}
            </datalist>
          </Field>
          <section className="ai-models field-wide" aria-label={`${detail.title}可支持的模型`}>
            <div className="ai-models-head">
              <span>可支持的模型</span>
              <small>{discoveredModels.length ? `${discoveredModels.length} 个` : "未探查"}</small>
            </div>
            {discoveredModels.length ? (
              <div className="ai-model-list">
                {discoveredModels.map(item => (
                  <button
                    type="button"
                    className={`ai-model-chip${model === item ? " is-selected" : ""}`}
                    onClick={() => setModel(target, item)}
                    key={item}
                    title={item}
                  >
                    <span>{item}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="ai-models-empty">保存此 API 的地址和密钥后，点击“探查模型列表”即可选择模型。</p>
            )}
          </section>
          <Field label="API 密钥" hint={configured ? "已保存；留空则保持不变" : "不会回显已保存的密钥，可留空"}>
            <input
              type="password"
              value={apiKeys[target]}
              onChange={event => setApiKeys(current => ({ ...current, [target]: event.target.value }))}
              placeholder={configured ? "已保存，留空则不修改" : "可留空"}
            />
          </Field>
          <label className="check-choice field-wide">
            <input
              type="checkbox"
              checked={clearKeys[target]}
              onChange={event => setClearKeys(current => ({ ...current, [target]: event.target.checked }))}
            />
            清除已保存的{detail.title}密钥
          </label>
          <div className="ai-action-grid field-wide">
            <Button variant="secondary" size="sm" onClick={() => void testConnection(target)} disabled={Boolean(testingConnection || discoveringModels)}>
              {testingConnection === target ? "测试链接中…" : "测试链接"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void discoverModelList(target)} disabled={Boolean(testingConnection || discoveringModels)}>
              {discoveringModels === target ? "探查中…" : "探查模型列表"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void testCurrentModel(target)} disabled={Boolean(testingModel)}>
              {testingModel === target ? "测试模型中…" : "测试模型"}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return <>
    <PageHeader
      kicker="设置 / AI"
      title="AI 能力设置"
      description="分别配置主 API 与备用 API。AI 任务优先使用主 API，发生连接或响应异常时自动按备用 API 的模型继续执行。配置只保存在本机 ai_settings.json，不会提交到 GitHub。"
      actions={<Button onClick={() => void save()} disabled={loading || saving}>{saving ? "保存中…" : "保存设置"}</Button>}
    />
    {error ? <ErrorState message={error} /> : null}
    {status ? <div className="inline-message"><Badge tone="success">接口</Badge>{status}</div> : null}
    {modelStatus ? <div className="inline-message"><Badge tone="success">模型</Badge>{modelStatus}</div> : null}
    {loading ? <LoadingState /> : (
      <div className="stack-grid ai-settings-stack">
        {renderApiConnectionCard("primary")}
        {renderApiConnectionCard("backup")}
        <p className="muted-line">密钥只保存在本机被 Git 忽略的 ai_settings.json；提示词由 ASR 等具体模块自行管理。</p>
      </div>
    )}
  </>;
}
