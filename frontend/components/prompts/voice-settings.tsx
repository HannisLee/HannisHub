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
      setConfig(await apiFetch<ExternalAsrSettings>(`${API_PATHS.prompts}/asr-settings`, { method: "PUT", body: jsonBody(config) }));
      setMessage("ASR 设置已保存，等待配置的录音将自动转写");
      window.dispatchEvent(new Event("hannishub:asr-settings"));
    } catch (value) { setError(errorMessage(value)); }
    finally { setSaving(false); }
  }

  return <Card className="prompt-settings-card">
    <CardHeader title="语音输入 · 外部 ASR 设置" description="使用 OpenAI 兼容音频转写协议。录音先本地保存、再上传归档，服务器转码后调用此接口。配置全部明文展示。"
      actions={<Button size="sm" disabled={!loaded || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存 ASR 设置"}</Button>} />
    {error ? <ErrorState message={error} /> : null}
    {message ? <p className="inline-message">{message}</p> : null}
    <div className="form-grid">
      {([
        ["api_url", "完整 API 地址", "https://你的服务/v1/audio/transcriptions"],
        ["api_key", "API Key（明文）", "填写服务 Key，使用 Bearer 鉴权"],
        ["model", "ASR 模型", "按服务要求填写，可留空"],
        ["language", "语言", "zh；留空自动识别"],
        ["archive_dir", "服务器归档目录", "默认 prompt_service/data/recordings，支持 ~/路径"],
      ] as const).map(([field, label, placeholder]) => <label className="prompt-settings-field" key={field}>
        <span>{label}</span><input type="text" value={config[field]} placeholder={placeholder} spellCheck={false} autoComplete="off" disabled={!loaded || saving}
          onChange={event => setConfig(current => ({ ...current, [field]: event.target.value }))} />
      </label>)}
      <label className="prompt-settings-field"><span>ASR 请求超时（秒）</span><input type="number" min={10} max={3600} value={config.timeout_seconds} disabled={!loaded || saving}
        onChange={event => setConfig(current => ({ ...current, timeout_seconds: Number(event.target.value) }))} /></label>
    </div>
    <p className="muted">{loaded ? `服务器 ffmpeg：${config.ffmpeg_available ? "可用" : "未安装，原音频仍可归档，安装后重试转码"}。` : "正在读取配置…"}归档保留原音频、16 kHz 单声道 MP3 和转写文本；第三方服务的音频大小与时长限制以服务要求为准。</p>
  </Card>;
}
