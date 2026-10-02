"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type { DownloadStatus, DownloadTask, ModelFile, ModelRepository } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, LoadingState, PageHeader, ProgressBar } from "../ui/primitives";

function filterByQuery<T>(items: T[], query: string, fields: (item: T) => (string | null | undefined)[]) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter(item => fields(item).join(" ").toLowerCase().includes(normalized));
}

export function DownloadsPanel() {
  const [repo, setRepo] = useState("");
  const [filename, setFilename] = useState("");
  const [force, setForce] = useState(false);
  const [status, setStatus] = useState<DownloadStatus | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [logs, setLogs] = useState("");
  const [models, setModels] = useState<ModelFile[]>([]);
  const [repositories, setRepositories] = useState<ModelRepository[]>([]);
  const [modelDir, setModelDir] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await apiFetch<DownloadStatus>(`${API_PATHS.llama}/download/status`));
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const [modelData, repositoryData] = await Promise.all([
        apiFetch<{ models: ModelFile[]; model_dir: string }>(`${API_PATHS.llama}/models`),
        apiFetch<{ repositories: ModelRepository[] }>(`${API_PATHS.llama}/model-repositories`),
      ]);
      setModels(modelData.models || []);
      setModelDir(modelData.model_dir || "");
      setRepositories(repositoryData.repositories || []);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async (id: string) => {
    try {
      const data = await apiFetch<{ logs: string }>(`${API_PATHS.llama}/download/logs${id ? `?task_id=${encodeURIComponent(id)}` : ""}`);
      setLogs(data.logs || "");
    } catch (value) {
      setLogs(`读取失败：${errorMessage(value)}`);
    }
  }, []);

  useEffect(() => {
    const firstLoad = window.setTimeout(() => void loadStatus(), 0);
    const timer = window.setInterval(() => void loadStatus(), 3000);
    return () => {
      window.clearTimeout(firstLoad);
      window.clearInterval(timer);
    };
  }, [loadStatus]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadLibrary(), 0);
    return () => window.clearTimeout(timer);
  }, [loadLibrary]);

  useEffect(() => {
    const firstLoad = window.setTimeout(() => void loadLogs(selectedId), 0);
    const timer = window.setInterval(() => void loadLogs(selectedId), 5000);
    return () => {
      window.clearTimeout(firstLoad);
      window.clearInterval(timer);
    };
  }, [loadLogs, selectedId]);

  async function startDownload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiFetch(`${API_PATHS.llama}/download`, { method: "POST", body: jsonBody({ repo, filename, force_download: force }) });
      setRepo("");
      setFilename("");
      await loadStatus();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(taskId?: string) {
    try {
      await apiFetch(`${API_PATHS.llama}/download/cancel`, { method: "POST", body: jsonBody({ task_id: taskId }) });
      await loadStatus();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  const tasks: DownloadTask[] = status?.downloads || [];
  const filteredModels = useMemo(
    () => filterByQuery(models, modelQuery, model => [model.name, model.path]),
    [models, modelQuery],
  );
  const filteredRepositories = useMemo(
    () => filterByQuery(repositories, repositoryQuery, repository => [repository.display_name, repository.path]),
    [repositories, repositoryQuery],
  );

  if (loading && !status) {
    return <>
      <PageHeader kicker="模型管理 / Downloads" title="模型下载" description="从 Hugging Face 下载单个 GGUF 文件或全量仓库，并集中查看本地模型资产。" />
      <LoadingState label="正在读取下载任务…" />
    </>;
  }

  return <>
    <PageHeader kicker="模型管理 / Downloads" title="模型下载" description="从 Hugging Face 下载单个 GGUF 文件或全量仓库，并集中查看本地模型资产。" />
    {error ? <ErrorState message={error} /> : null}
    <div className="stack-grid">
      <Card>
        <CardHeader
          title="新建下载"
          description={modelDir ? `文件名留空时下载整个仓库；当前模型目录：${modelDir}` : "文件名留空时会下载整个仓库。"}
        />
        <form className="form-grid" onSubmit={startDownload}>
          <Field label="仓库 ID" hint="格式：owner/repo"><input value={repo} onChange={event => setRepo(event.target.value)} placeholder="tencent/Hy-MT2-7B-GGUF" required /></Field>
          <Field label="文件名" hint="只下载单个文件时填写 .gguf 文件名"><input value={filename} onChange={event => setFilename(event.target.value)} placeholder="留空则下载完整仓库" /></Field>
          <label className="check-choice field-wide"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />强制重新下载，忽略本地缓存校验</label>
          <div className="form-actions field-wide"><Button type="submit" disabled={busy}>{busy ? "正在创建…" : "开始下载"}</Button></div>
        </form>
      </Card>

      <Card>
        <CardHeader title="任务状态" description="后台下载任务会持续写入独立日志。" />
        {status?.running ? (
          <div className="download-current">
            <div className="split-line"><strong>{status.repo}</strong><Badge tone="warning">下载中</Badge></div>
            <span>{status.filename || "全量仓库"}</span>
            <ProgressBar value={status.progress || 0} />
            <div className="split-line"><small>{status.progress?.toFixed(1) || 0}%</small><small>{status.target_dir || ""}</small></div>
            <Button size="sm" variant="danger" onClick={() => void cancel()}>请求取消</Button>
          </div>
        ) : <EmptyState title="当前没有运行中的下载" detail="新任务的实时进度会显示在这里。" />}
        {status?.error ? <div className="error-state"><span>{status.error}</span></div> : null}
      </Card>

      <Card>
        <CardHeader
          title={`GGUF 模型 · ${models.length}`}
          description="递归扫描模型目录中的 .gguf 文件。"
          actions={<><input className="search-input" value={modelQuery} onChange={event => setModelQuery(event.target.value)} placeholder="搜索名称或路径" /><Button variant="secondary" size="sm" onClick={() => void loadLibrary()}>刷新</Button></>}
        />
        {libraryLoading && !models.length ? <LoadingState label="正在读取本地 GGUF 模型…" /> : filteredModels.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th>路径</th></tr></thead>
              <tbody>{filteredModels.map(model => (
                <tr key={model.path}>
                  <td><strong>{model.name}</strong></td>
                  <td>{formatBytes(model.size)}</td>
                  <td>{formatDate(model.modified)}</td>
                  <td><code className="path-cell">{model.path}</code></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <EmptyState title="没有找到 GGUF 模型" detail={modelQuery ? "尝试换一个搜索词。" : "设置模型目录后，模型会出现在这里。"} />}
      </Card>

      <Card>
        <CardHeader
          title={`全量仓库 · ${repositories.length}`}
          description="保留仓库结构的下载目录，可用于 vLLM 等服务。"
          actions={<><input className="search-input" value={repositoryQuery} onChange={event => setRepositoryQuery(event.target.value)} placeholder="搜索名称或路径" /><Button variant="secondary" size="sm" onClick={() => void loadLibrary()}>刷新</Button></>}
        />
        {libraryLoading && !repositories.length ? <LoadingState label="正在读取全量仓库…" /> : filteredRepositories.length ? (
          <div className="repository-grid">{filteredRepositories.map(repository => (
            <article className="repository-card" key={repository.path}>
              <div className="repository-title"><strong>{repository.display_name}</strong><Badge tone={repository.has_model_files ? "success" : "neutral"}>{repository.has_model_files ? "含模型文件" : "目录"}</Badge></div>
              <code>{repository.path}</code>
              <div className="repository-meta"><span>{repository.has_config ? "有 config.json" : "无 config.json"}</span><span>{formatDate(repository.modified)}</span></div>
            </article>
          ))}</div>
        ) : <EmptyState title="没有全量仓库" detail={repositoryQuery ? "尝试换一个搜索词。" : "新建下载时留空文件名即可下载整个仓库。"} />}
      </Card>

      <Card>
        <CardHeader
          title={`下载历史 · ${tasks.length}`}
          description="选择任务查看尾部 100 行日志。"
          actions={<select className="select-compact" value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">最新任务</option>{tasks.map(task => <option value={task.id} key={task.id}>{task.repo} · {task.id}</option>)}</select>}
        />
        {tasks.length ? (
          <div className="stack-list">{tasks.map(task => (
            <article className="download-row" key={task.id}>
              <div>
                <strong>{task.repo}</strong>
                <span>{task.filename || "完整仓库"} · {formatDate(task.created_at)}</span>
                <code>{task.target_dir || "—"}</code>
              </div>
              <div className="download-row-end">
                <Badge tone={task.running ? "warning" : task.error ? "error" : task.done ? "success" : "neutral"}>{task.running ? "下载中" : task.error ? "失败" : task.done ? "完成" : "等待"}</Badge>
                {task.progress_total ? <span>{formatBytes(task.progress_n)} / {formatBytes(task.progress_total)}</span> : null}
                {task.running ? <Button size="sm" variant="danger" onClick={() => void cancel(task.id)}>取消</Button> : null}
              </div>
            </article>
          ))}</div>
        ) : <EmptyState title="还没有下载任务" detail="下载任务会显示在这里。" />}
        <pre className="log-viewer">{logs || "暂无下载日志"}</pre>
      </Card>
    </div>
  </>;
}
