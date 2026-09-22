"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { LlamaSettings } from "../../lib/types";
import { Button, Card, CardHeader, ErrorState, Field, LoadingState, PageHeader, Badge } from "../ui/primitives";

export function SettingsPanel() {
  const [settings, setSettings] = useState<LlamaSettings>({});
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    try { setSettings(await apiFetch<LlamaSettings>(`${API_PATHS.llama}/settings`)); setError(""); } catch (value) { setError(errorMessage(value)); } finally { setLoading(false); }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function save() {
    try {
      const data = await apiFetch<{ data: LlamaSettings }>(`${API_PATHS.llama}/settings`, { method: "POST", body: jsonBody({ model_dir: settings.model_dir || "", gpu_history_hours: Number(settings.gpu_history_hours || 2), openai_api_base_url: settings.openai_api_base_url || "", openai_api_model: settings.openai_api_model || "", openai_api_key: apiKey, clear_openai_api_key: clearKey }) });
      setSettings(data.data || settings); setApiKey(""); setClearKey(false); setStatus("设置已保存");
    } catch (value) { setError(errorMessage(value)); }
  }
  async function testConnection() {
    try { const result = await apiFetch<{ message: string; models?: string[] }>(`${API_PATHS.llama}/openai/test`, { method: "POST" }); setStatus(result.message || "连接成功"); if (!settings.openai_api_model && result.models?.length) setSettings({ ...settings, openai_api_model: result.models[0] }); } catch (value) { setError(errorMessage(value)); }
  }
  async function detect() {
    try { const result = await apiFetch<{ found?: string; paths?: string[]; message?: string }>(`${API_PATHS.llama}/detect-llama-cpp`); setStatus(result.found || result.paths?.join(", ") || result.message || "检测完成"); } catch (value) { setError(errorMessage(value)); }
  }

  return <>
    <PageHeader kicker="模型管理 / Settings" title="模型设置" description="配置模型目录、GPU 历史保留时长和 OpenAI 兼容的提取服务。" actions={<Button onClick={() => void save()}>保存设置</Button>} />
    {error ? <ErrorState message={error} /> : null}
    {status ? <div className="inline-message"><Badge tone="success">完成</Badge>{status}</div> : null}
    {loading ? <LoadingState /> : <div className="settings-grid"><Card><CardHeader title="本机环境" description="路径中的 ~ 会由后端展开。" /><div className="form-grid"><Field label="模型目录"><input value={String(settings.model_dir || "")} onChange={event => setSettings({ ...settings, model_dir: event.target.value })} placeholder="例如：~/models" /></Field><Field label="GPU 历史小时数"><input type="number" min="0.25" max="168" step="0.25" value={Number(settings.gpu_history_hours || 2)} onChange={event => setSettings({ ...settings, gpu_history_hours: Number(event.target.value) })} /></Field><div className="form-actions field-wide"><Button variant="secondary" size="sm" onClick={() => void detect()}>检测 llama.cpp</Button></div></div></Card><Card><CardHeader title="OpenAI 兼容 API" description="ASR 信息提取和其他兼容模型操作会使用这些配置。" /><div className="form-grid"><Field label="API 地址"><input type="url" value={String(settings.openai_api_base_url || "")} onChange={event => setSettings({ ...settings, openai_api_base_url: event.target.value })} placeholder="https://api.openai.com/v1" /></Field><Field label="模型名称"><input value={String(settings.openai_api_model || "")} onChange={event => setSettings({ ...settings, openai_api_model: event.target.value })} placeholder="先测试连接获取模型" /></Field><Field label="API 密钥" hint={settings.openai_api_key_configured ? "已保存；留空则保持不变" : "不会回显已保存的密钥"}><input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={settings.openai_api_key_configured ? "已保存，留空则不修改" : "可留空"} /></Field><label className="check-choice field-wide"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />清除已保存的 API 密钥</label><div className="form-actions field-wide"><Button variant="secondary" size="sm" onClick={() => void testConnection()}>测试连接</Button></div></div></Card></div>}
  </>;
}
