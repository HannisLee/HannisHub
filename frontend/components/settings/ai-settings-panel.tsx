"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { AiConnectionTestResult, AiSettings } from "../../lib/types";
import { Badge, Button, Card, CardHeader, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

const EMPTY_SETTINGS: AiSettings = {
  openai_api_base_url: "",
  openai_api_model: "",
  openai_api_key_configured: false,
  asr_extraction_prompt: "",
};

export function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettings>(EMPTY_SETTINGS);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

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
          asr_extraction_prompt: settings.asr_extraction_prompt || "",
        }),
      });
      setSettings(data);
      setApiKey("");
      setClearKey(false);
      setStatus("AI 设置已保存到本机 ai_settings.json");
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      const result = await apiFetch<AiConnectionTestResult>(`${API_PATHS.aiSettings}/test`, { method: "POST" });
      setStatus(result.message || "连接成功");
      if (!settings.openai_api_model && result.models?.length) {
        patchSettings({ openai_api_model: result.models[0] });
      }
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setTesting(false);
    }
  }

  return <>
    <PageHeader
      kicker="设置 / AI"
      title="AI 能力设置"
      description="集中配置 OpenAI 兼容 API、模型和音频转写提炼提示词；配置保存在本机 ai_settings.json，不会提交到 GitHub。"
      actions={<Button onClick={() => void save()} disabled={loading || saving}>{saving ? "保存中…" : "保存设置"}</Button>}
    />
    {error ? <ErrorState message={error} /> : null}
    {status ? <div className="inline-message"><Badge tone="success">完成</Badge>{status}</div> : null}
    {loading ? <LoadingState /> : (
      <div className="settings-grid">
        <Card>
          <CardHeader title="OpenAI 兼容 API" description="ASR 提炼和后续需要 AI 能力的模块都会复用这里的接口配置。" />
          <div className="form-grid">
            <Field label="API 地址">
              <input
                type="url"
                value={settings.openai_api_base_url}
                onChange={event => patchSettings({ openai_api_base_url: event.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </Field>
            <Field label="模型名称">
              <input
                value={settings.openai_api_model}
                onChange={event => patchSettings({ openai_api_model: event.target.value })}
                placeholder="先测试连接获取模型"
              />
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
            <div className="form-actions field-wide">
              <Button variant="secondary" size="sm" onClick={() => void testConnection()} disabled={testing}>
                {testing ? "测试中…" : "测试连接"}
              </Button>
              <span className="muted-line">密钥只保存在本机被 Git 忽略的 ai_settings.json。</span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="音频转写提炼提示词" description="用于从已完成的 ASR 转写文本中提炼关键信息。" />
          <div className="form-grid">
            <Field label="提示词">
              <textarea
                className="ai-prompt-editor"
                rows={10}
                value={settings.asr_extraction_prompt}
                onChange={event => patchSettings({ asr_extraction_prompt: event.target.value })}
              />
            </Field>
            <p className="muted-line">提示词会作为 system 消息发送；请避免在这里保存其他敏感信息。</p>
          </div>
        </Card>
      </div>
    )}
  </>;
}
