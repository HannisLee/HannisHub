"use client";

import { useEffect, useRef, useState } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody, uploadFile } from "../../lib/api";
import { errorMessage, formatDate } from "../../lib/format";
import type { AsrInfo, AsrRecord } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, LoadingState, PageHeader, ProgressBar } from "../ui/primitives";

interface UploadState { id: string; name: string; progress: number; status: string; detail: string; }

export function AsrPanel() {
  const [info, setInfo] = useState<AsrInfo | null>(null);
  const [records, setRecords] = useState<AsrRecord[]>([]);
  const [prompt, setPrompt] = useState("");
  const [extraction, setExtraction] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const [asr, history, settings] = await Promise.all([
        apiFetch<AsrInfo>(`${API_PATHS.llama}/asr`),
        apiFetch<{ records: AsrRecord[] }>(`${API_PATHS.llama}/asr/history`),
        apiFetch<{ prompt: string }>(`${API_PATHS.llama}/asr/extraction-settings`),
      ]);
      setInfo(asr); setRecords(history.records || []); setPrompt(settings.prompt || ""); setError("");
    } catch (value) { setError(errorMessage(value)); }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void apiFetch<{ records: AsrRecord[] }>(`${API_PATHS.llama}/asr/history`).then(data => setRecords(data.records || [])).catch(() => {}), 3000); return () => window.clearInterval(timer); }, []);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    for (const file of selected) {
      const id = `${Date.now()}-${file.name}`;
      setUploads(current => [...current, { id, name: file.name, progress: 0, status: "准备上传", detail: `${(file.size / 1024 / 1024).toFixed(1)} MB` }]);
      try {
        await uploadFile(`${API_PATHS.llama}/asr/transcriptions`, file, progress => setUploads(current => current.map(item => item.id === id ? { ...item, progress, status: "正在上传", detail: `${progress}%` } : item)));
        setUploads(current => current.map(item => item.id === id ? { ...item, progress: 100, status: "已接收", detail: "正在等待转写" } : item));
      } catch (value) { setUploads(current => current.map(item => item.id === id ? { ...item, status: "上传失败", detail: errorMessage(value) } : item)); }
    }
    await load();
  }

  async function savePrompt() {
    try { await apiFetch(`${API_PATHS.llama}/asr/extraction-settings`, { method: "PUT", body: jsonBody({ prompt }) }); setError(""); } catch (value) { setError(errorMessage(value)); }
  }
  async function showText(recordId: string, suffix: "text" | "extraction") {
    try { const data = await apiFetch<{ text: string }>(`${API_PATHS.llama}/asr/history/${encodePath(recordId)}/${suffix}`); setExtraction(current => ({ ...current, [recordId]: data.text })); } catch (value) { setError(errorMessage(value)); }
  }
  async function extract(recordId: string) {
    try { const data = await apiFetch<{ text: string }>(`${API_PATHS.llama}/asr/history/${encodePath(recordId)}/extraction`, { method: "POST" }); setExtraction(current => ({ ...current, [recordId]: data.text })); await load(); } catch (value) { setError(errorMessage(value)); }
  }
  async function rename(record: AsrRecord) {
    const name = window.prompt("请输入新的记录名称", record.name || record.filename || "");
    if (!name) return;
    try { await apiFetch(`${API_PATHS.llama}/asr/history/${encodePath(record.id)}`, { method: "PATCH", body: jsonBody({ name }) }); await load(); } catch (value) { setError(errorMessage(value)); }
  }
  async function remove(record: AsrRecord) {
    if (!window.confirm("确定删除这条转写历史吗？")) return;
    try { await apiFetch(`${API_PATHS.llama}/asr/history/${encodePath(record.id)}`, { method: "DELETE" }); await load(); } catch (value) { setError(errorMessage(value)); }
  }

  return <>
    <PageHeader kicker="模型管理 / ASR" title="音频转写" description="上传音频到受管 ASR 服务，后台切片、转写并保存历史文本。" actions={<Button onClick={() => inputRef.current?.click()}>上传音频</Button>} />
    <input ref={inputRef} className="visually-hidden" type="file" accept="audio/*,video/*,.m4s,.mkv,.ts" multiple onChange={event => { void upload(event.target.files); event.target.value = ""; }} />
    {error ? <ErrorState message={error} /> : null}
    <div className="two-column-grid">
      <Card>
        <CardHeader title="ASR 服务" description="当前由模型管理模块发现的唯一 ASR 实例。" />
        {info ? <div className="asr-service"><Badge tone="success">可用</Badge><strong>{info.name}</strong><span>PID {info.pid} · 单段最长 {info.max_chunk_seconds} 秒</span><Button variant="secondary" size="sm" onClick={() => window.open(`${API_PATHS.llama.replace("/api", "")}/asr`, "_blank")}>打开独立页面</Button></div> : <LoadingState />}
        <div
          className="upload-drop"
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inputRef.current?.click(); } }}
          onDragOver={event => event.preventDefault()}
          onDrop={event => { event.preventDefault(); void upload(event.dataTransfer.files); }}
        ><span className="upload-mark">↑</span><strong>拖入音频，或点击选择文件</strong><small>支持 FFmpeg 可以解码的常见音视频格式，单文件最大 4 GB。</small></div>
        {uploads.length ? <div className="upload-list">{uploads.map(item => <div className="upload-row" key={item.id}><div><strong>{item.name}</strong><span>{item.status} · {item.detail}</span></div><ProgressBar value={item.progress} /></div>)}</div> : null}
      </Card>
      <Card>
        <CardHeader title="信息提取提示词" description="用于从已完成的转写文本提炼关键信息。" actions={<Button size="sm" onClick={() => void savePrompt()}>保存</Button>} />
        <Field label="提示词"><textarea rows={8} value={prompt} onChange={event => setPrompt(event.target.value)} /></Field>
      </Card>
    </div>
    <Card>
      <CardHeader title={`转写历史 · ${records.length}`} description="历史内容保存在本机，列表会每 3 秒更新一次。" />
      {records.length ? <div className="stack-list">{records.map(record => <article className="history-row" key={record.id}><div className="history-main"><div className="history-title"><strong>{record.name || record.filename || record.id}</strong><Badge tone={record.status === "completed" ? "success" : record.status === "error" ? "error" : "warning"}>{record.status || "unknown"}</Badge></div><span>{formatDate(record.created_at)} · {record.progress_detail || ""}</span>{record.progress !== undefined && record.status !== "completed" ? <ProgressBar value={record.progress || 0} /> : null}{record.error ? <small className="error-text">{record.error}</small> : null}</div><div className="row-actions"><Button size="sm" variant="quiet" onClick={() => void showText(record.id, "text")}>全文</Button>{record.status === "completed" ? <><Button size="sm" variant="quiet" onClick={() => void extract(record.id)}>提炼</Button><Button size="sm" variant="quiet" onClick={() => void showText(record.id, "extraction")}>结果</Button></> : null}<Button size="sm" variant="quiet" onClick={() => void rename(record)}>重命名</Button><Button size="sm" variant="danger" onClick={() => void remove(record)}>删除</Button></div>{extraction[record.id] ? <pre className="text-preview">{extraction[record.id]}</pre> : null}</article>)}</div> : <EmptyState title="还没有转写历史" detail="上传第一个音频后，后台结果会显示在这里。" />}
    </Card>
  </>;
}
