"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { ExternalAsrSettings } from "../../lib/prompt-audio";
import { Button, Card, CardHeader, ErrorState } from "../ui/primitives";

const EMPTY_SETTINGS: ExternalAsrSettings = { api_url: "", api_key: "", model: "", language: "", archive_dir: "", timeout_seconds: 300 };

export function VoiceSettings() {
  const [config, setConfig] = useState(EMPTY_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void apiFetch<ExternalAsrSettings>(`${API_PATHS.prompts}/asr-settings`).then(data => {
      setConfig(data);
      setLoaded(true);
    }).catch(value => setError(errorMessage(value)));
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const { api_url, api_key, model, language } = config;
      setConfig(await apiFetch<ExternalAsrSettings>(`${API_PATHS.prompts}/asr-settings`, { method: "PUT", body: jsonBody({ api_url, api_key, model, language }) }));
      setMessage("ASR 设置已保存，等待配置的录音将自动转写");
      window.dispatchEvent(new Event("hannishub:asr-settings"));
    } catch (value) { setError(errorMessage(value)); }
    finally { setSaving(false); }
  }

  return <Card className="prompt-settings-card">
    <CardHeader title="语音输入 · ASR 设置" description="检测到本机 ASR 运行时优先本机转写；未运行时使用下面的外部配置。支持小米 MiMo ASR 与 OpenAI 兼容服务。"
      actions={<Button size="sm" disabled={!loaded || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存 ASR 设置"}</Button>} />
    {error ? <ErrorState message={error} /> : null}
    {message ? <p className="inline-message">{message}</p> : null}
    <div className="form-grid">
      {([
        ["api_url", "API 地址", "基础地址（如 https://api.xiaomimimo.com/v1）或完整端点"],
        ["api_key", "API Key（明文）", "填写服务 Key，使用 Bearer 鉴权"],
        ["model", "ASR 模型", "按服务要求填写，可留空"],
        ["language", "语言", "zh；留空自动识别"],
      ] as const).map(([field, label, placeholder]) => <label className="prompt-settings-field" key={field}>
        <span>{label}</span><input type="text" value={config[field]} placeholder={placeholder} spellCheck={false} autoComplete="off" disabled={!loaded || saving}
          onChange={event => setConfig(current => ({ ...current, [field]: event.target.value }))} />
      </label>)}
    </div>
    {loaded ? <>
      <p className="muted">录音自动归档，保留原音频、转码音频和转写文本。</p>
      {config.local_asr?.available ?
        <p className="inline-message">已检测到本机 ASR「{config.local_asr.name}」，新录音和重试任务会优先使用本机切片转写。</p>
        : <p className="muted">当前未检测到运行中的本机 ASR，将使用外部配置。</p>}
      <details className="prompt-audio-storage"><summary>查看归档位置与实际接口</summary>
        <p className="muted">归档位置：{config.resolved_archive_dir || config.archive_dir || "prompt_service/data/recordings"}</p>
        <p className="muted">优先接口：{config.local_asr?.available ? `本机 ${config.local_asr.name}` : "未运行"}</p>
        <p className="muted">外部接口：{config.resolved_api_url || "尚未配置"}</p>
      </details>
      {!config.ffmpeg_available ? <ErrorState message="服务器尚未安装 ffmpeg，原音频会保留，安装后可重试转码。" /> : null}
    </> : <p className="muted">正在读取配置…</p>}
  </Card>;
}
