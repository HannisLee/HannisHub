"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type { DownloadStatus, DownloadTask } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, PageHeader, ProgressBar } from "../ui/primitives";

export function DownloadsPanel() {
  const [repo, setRepo] = useState("");
  const [filename, setFilename] = useState("");
  const [force, setForce] = useState(false);
  const [status, setStatus] = useState<DownloadStatus | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [logs, setLogs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function loadStatus() {
    try { setStatus(await apiFetch<DownloadStatus>(`${API_PATHS.llama}/download/status`)); setError(""); } catch (value) { setError(errorMessage(value)); }
  }
  const loadLogs = useCallback(async (id: string) => {
    try { const data = await apiFetch<{ logs: string }>(`${API_PATHS.llama}/download/logs${id ? `?task_id=${encodeURIComponent(id)}` : ""}`); setLogs(data.logs || ""); } catch (value) { setLogs(`读取失败：${errorMessage(value)}`); }
  }, []);
  useEffect(() => {
    const firstLoad = window.setTimeout(() => void loadStatus(), 0);
    const timer = window.setInterval(() => void loadStatus(), 3000);
    return () => { window.clearTimeout(firstLoad); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const firstLoad = window.setTimeout(() => void loadLogs(selectedId), 0);
    const timer = window.setInterval(() => void loadLogs(selectedId), 5000);
    return () => { window.clearTimeout(firstLoad); window.clearInterval(timer); };
  }, [loadLogs, selectedId]);

  async function startDownload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try { await apiFetch(`${API_PATHS.llama}/download`, { method: "POST", body: jsonBody({ repo, filename, force_download: force }) }); setRepo(""); setFilename(""); await loadStatus(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(false); }
  }
  async function cancel(taskId?: string) {
    try { await apiFetch(`${API_PATHS.llama}/download/cancel`, { method: "POST", body: jsonBody({ task_id: taskId }) }); await loadStatus(); } catch (value) { setError(errorMessage(value)); }
  }

  const tasks: DownloadTask[] = status?.downloads || [];
  return <>
    <PageHeader kicker="模型管理 / Downloads" title="模型下载" description="从 Hugging Face 下载单个 GGUF 文件，或保留目录结构完整下载仓库。" />
    {error ? <ErrorState message={error} /> : null}
    <div className="two-column-grid">
      <Card>
        <CardHeader title="新建下载" description="文件名留空时会下载整个仓库。" />
        <form className="form-grid" onSubmit={startDownload}>
          <Field label="仓库 ID" hint="格式：owner/repo"><input value={repo} onChange={event => setRepo(event.target.value)} placeholder="tencent/Hy-MT2-7B-GGUF" required /></Field>
          <Field label="文件名" hint="只下载单个文件时填写 .gguf 文件名"><input value={filename} onChange={event => setFilename(event.target.value)} placeholder="留空则下载完整仓库" /></Field>
          <label className="check-choice field-wide"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />强制重新下载，忽略本地缓存校验</label>
          <div className="form-actions field-wide"><Button type="submit" disabled={busy}>{busy ? "正在创建…" : "开始下载"}</Button></div>
        </form>
      </Card>
      <Card>
        <CardHeader title="任务状态" description="后台下载任务会持续写入独立日志。" />
        {status?.running ? <div className="download-current"><div className="split-line"><strong>{status.repo}</strong><Badge tone="warning">下载中</Badge></div><span>{status.filename || "全量仓库"}</span><ProgressBar value={status.progress || 0} /><div className="split-line"><small>{status.progress?.toFixed(1) || 0}%</small><small>{status.target_dir || ""}</small></div><Button size="sm" variant="danger" onClick={() => void cancel()}>请求取消</Button></div> : <EmptyState title="当前没有运行中的下载" detail="新任务的实时进度会显示在这里。" />}
        {status?.error ? <div className="error-state"><span>{status.error}</span></div> : null}
      </Card>
    </div>
    <Card>
      <CardHeader title={`下载历史 · ${tasks.length}`} description="选择任务查看尾部 100 行日志。" actions={<select className="select-compact" value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">最新任务</option>{tasks.map(task => <option value={task.id} key={task.id}>{task.repo} · {task.id}</option>)}</select>} />
      {tasks.length ? <div className="stack-list">{tasks.map(task => <article className="download-row" key={task.id}><div><strong>{task.repo}</strong><span>{task.filename || "完整仓库"} · {formatDate(task.created_at)}</span><code>{task.target_dir || "—"}</code></div><div className="download-row-end"><Badge tone={task.running ? "warning" : task.error ? "error" : task.done ? "success" : "neutral"}>{task.running ? "下载中" : task.error ? "失败" : task.done ? "完成" : "等待"}</Badge>{task.progress_total ? <span>{formatBytes(task.progress_n)} / {formatBytes(task.progress_total)}</span> : null}{task.running ? <Button size="sm" variant="danger" onClick={() => void cancel(task.id)}>取消</Button> : null}</div></article>)}</div> : <EmptyState title="还没有下载任务" detail="下载任务会显示在这里。" />}
      <pre className="log-viewer">{logs || "暂无下载日志"}</pre>
    </Card>
  </>;
}
