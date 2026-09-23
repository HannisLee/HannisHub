"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { AiConnectionTestResult, AiModelTestResult, AiSettings } from "../../lib/types";
import { Badge, Button, Card, CardHeader, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

const EMPTY_SETTINGS: AiSettings = {
  openai_api_base_url: "",
  openai_api_model: "",
  openai_api_key_configured: false,
};

export function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettings>(EMPTY_SETTINGS);
  const [models, setModels] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [status, setStatus] = useState("");
  const [modelStatus, setModelStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [testingModel, setTestingModel] = useState(false);

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

  function patchSettings(patch: Partial<AiSettings>) {
    setSettings(current => ({ ...current, ...patch }));
  }

  async function save() {
    setSaving(true);
    try {
      const data = await apiFetch<AiSettings>(API_PATHS.aiSettings, {
        method: "PUT",
        body: jsonBody({
          openai_api_base_url: settings.openai_api_base_url || "",
          openai_api_model: settings.openai_api_model || "",
          openai_api_key: apiKey,
          clear_openai_api_key: clearKey,
        }),
      });
      setSettings(data);
      setApiKey("");
      setClearKey(false);
      setStatus("AI 设置已保存到本机 ai_settings.json");
      setModelStatus("");
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSaving(false);
    }
  }

  async function discoverModelList() {
    setDiscoveringModels(true);
    try {
      const result = await apiFetch<AiConnectionTestResult>(`${API_PATHS.aiSettings}/models`, { method: "POST" });
      setModels(result.models || []);
      setStatus(result.message || `已发现 ${result.models?.length || 0} 个模型`);
      if (!settings.openai_api_model && result.models?.length) {
        patchSettings({ openai_api_model: result.models[0] });
      }
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setDiscoveringModels(false);
    }
  }

  async function testConnection() {
    setTestingConnection(true);
    try {
      const result = await apiFetch<AiConnectionTestResult>(`${API_PATHS.aiSettings}/test`, { method: "POST" });
      setModels(result.models || []);
      setStatus(result.message || "连接成功");
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setTestingConnection(false);
    }
  }

  async function testCurrentModel() {
    if (!settings.openai_api_model.trim()) {
      setModelStatus("");
      setError("请先选择或输入模型名称");
      return;
    }
    setTestingModel(true);
    try {
      const result = await apiFetch<AiModelTestResult>(`${API_PATHS.aiSettings}/model-test`, {
        method: "POST",
        body: jsonBody({ model: settings.openai_api_model }),
      });
      setModelStatus(result.response ? `${result.message}：${result.response}` : result.message);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setTestingModel(false);
    }
  }

  return <>
    <PageHeader
      kicker="设置 / AI"
      title="AI 能力设置"
      description="集中配置 OpenAI 兼容 API 和模型；各业务模块的提示词放在对应功能页面中。配置保存在本机 ai_settings.json，不会提交到 GitHub。"
      actions={<Button onClick={() => void save()} disabled={loading || saving}>{saving ? "保存中…" : "保存设置"}</Button>}
    />
    {error ? <ErrorState message={error} /> : null}
    {status ? <div className="inline-message"><Badge tone="success">接口</Badge>{status}</div> : null}
    {modelStatus ? <div className="inline-message"><Badge tone="success">模型</Badge>{modelStatus}</div> : null}
    {loading ? <LoadingState /> : (
      <div className="settings-grid">
        <Card>
          <CardHeader title="OpenAI 兼容 API" description="ASR 提炼和后续需要 AI 能力的模块都会复用这里的接口与模型配置。" />
          <div className="form-grid">
            <Field label="API 地址">
              <input
                type="url"
                value={settings.openai_api_base_url}
                onChange={event => patchSettings({ openai_api_base_url: event.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </Field>
            <Field label="模型选择" hint="可从列表选择，也可以直接输入自定义模型名称">
              <input
                list="ai-model-options"
                value={settings.openai_api_model}
                onChange={event => patchSettings({ openai_api_model: event.target.value })}
                placeholder="先探查模型列表，或直接输入模型名"
              />
              <datalist id="ai-model-options">
                {models.map(model => <option value={model} key={model}>{model}</option>)}
              </datalist>
            </Field>
            <Field
              label="API 密钥"
              hint={settings.openai_api_key_configured ? "已保存；留空则保持不变" : "不会回显已保存的密钥"}
            >
              <input
                type="password"
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder={settings.openai_api_key_configured ? "已保存，留空则不修改" : "可留空"}
              />
            </Field>
            <label className="check-choice field-wide">
              <input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />
              清除已保存的 API 密钥
            </label>
            <div className="ai-action-grid field-wide">
              <Button variant="secondary" size="sm" onClick={() => void testConnection()} disabled={testingConnection || discoveringModels}>
                {testingConnection ? "测试链接中…" : "测试链接"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void discoverModelList()} disabled={testingConnection || discoveringModels}>
                {discoveringModels ? "探查中…" : "探查模型列表"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void testCurrentModel()} disabled={testingModel}>
                {testingModel ? "测试模型中…" : "测试模型"}
              </Button>
            </div>
            <p className="muted-line">密钥只保存在本机被 Git 忽略的 ai_settings.json；提示词由 ASR 等具体模块自行管理。</p>
          </div>
        </Card>
      </div>
    )}
  </>;
}
