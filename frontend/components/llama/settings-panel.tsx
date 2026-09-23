"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { LlamaSettings } from "../../lib/types";
import { Badge, Button, Card, CardHeader, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

export function SettingsPanel() {
  const [settings, setSettings] = useState<LlamaSettings>({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setSettings(await apiFetch<LlamaSettings>(`${API_PATHS.llama}/settings`));
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

  async function save() {
    try {
      const data = await apiFetch<{ data: LlamaSettings }>(`${API_PATHS.llama}/settings`, {
        method: "POST",
        body: jsonBody({
          model_dir: settings.model_dir || "",
          gpu_history_hours: Number(settings.gpu_history_hours || 2),
        }),
      });
      setSettings(data.data || settings);
      setStatus("设置已保存");
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function detect() {
    try {
      const result = await apiFetch<{ found?: string; paths?: string[]; message?: string }>(`${API_PATHS.llama}/detect-llama-cpp`);
      setStatus(result.found || result.paths?.join(", ") || result.message || "检测完成");
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  return <>
    <PageHeader kicker="模型管理 / Settings" title="模型设置" description="配置模型目录、GPU 历史保留时长和本机 llama.cpp 环境。AI 接口已迁移到统一设置模块。" actions={<Button onClick={() => void save()}>保存设置</Button>} />
    {error ? <ErrorState message={error} /> : null}
    {status ? <div className="inline-message"><Badge tone="success">完成</Badge>{status}</div> : null}
    {loading ? <LoadingState /> : (
      <div className="settings-grid">
        <Card>
          <CardHeader title="本机环境" description="路径中的 ~ 会由后端展开。" />
          <div className="form-grid">
            <Field label="模型目录">
              <input value={String(settings.model_dir || "")} onChange={event => setSettings({ ...settings, model_dir: event.target.value })} placeholder="例如：~/models" />
            </Field>
            <Field label="GPU 历史小时数">
              <input type="number" min="0.25" max="168" step="0.25" value={Number(settings.gpu_history_hours || 2)} onChange={event => setSettings({ ...settings, gpu_history_hours: Number(event.target.value) })} />
            </Field>
            <div className="form-actions field-wide">
              <Button variant="secondary" size="sm" onClick={() => void detect()}>检测 llama.cpp</Button>
              <a className="text-link" href="/settings">前往 AI 设置 →</a>
            </div>
          </div>
        </Card>
      </div>
    )}
  </>;
}
