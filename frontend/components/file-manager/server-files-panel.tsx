"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type {
  Connection,
  RemoteFileDirectoryResponse,
  RemoteFileDownloadJob,
  RemoteFileDownloadStatus,
  RemoteFileEntry,
} from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader, ProgressBar } from "../ui/primitives";

const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const downloadStatusLabels: Record<RemoteFileDownloadStatus, string> = {
  queued: "排队中",
  running: "SSH 传输中",
  completed: "已到 Hub",
  failed: "失败",
  canceled: "已取消",
};

function parentRemotePath(path: string): string {
  if (!path || path === "/") return "/";
  const parent = path.slice(0, path.lastIndexOf("/"));
  return parent || "/";
}

function remotePathAt(segments: string[], index: number): string {
  return `/${segments.slice(0, index + 1).join("/")}`;
}

function formatRemoteBytes(value: number): string {
  return value ? formatBytes(value) : "0 B";
}

export function ServerFilesPanel() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [activePath, setActivePath] = useState("");
  const [directory, setDirectory] = useState<RemoteFileDirectoryResponse | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [query, setQuery] = useState("");
  const [startingPath, setStartingPath] = useState("");
  const [jobs, setJobs] = useState<RemoteFileDownloadJob[]>([]);
  const [jobsError, setJobsError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lastDirectoryRequest = useRef("");
  const directoryRequestId = useRef(0);

  const loadDirectory = useCallback(async (connectionId: string, remotePath: string) => {
    const requestKey = `${connectionId}:${remotePath}`;
    if (lastDirectoryRequest.current === requestKey) return;
    lastDirectoryRequest.current = requestKey;
    const currentRequest = ++directoryRequestId.current;
    setDirectoryLoading(true);
    setDirectoryError("");
    try {
      const result = await apiFetch<RemoteFileDirectoryResponse>(
        `${API_PATHS.server}/files/${encodePath(connectionId)}?${new URLSearchParams({ path: remotePath })}`,
      );
      if (currentRequest !== directoryRequestId.current) return;
      setDirectory(result);
      lastDirectoryRequest.current = `${connectionId}:${result.path}`;
      setActivePath(result.path);
      setPathInput(result.path);
    } catch (value) {
      if (currentRequest !== directoryRequestId.current) return;
      setDirectory(null);
      setDirectoryError(errorMessage(value));
    } finally {
      if (currentRequest === directoryRequestId.current) setDirectoryLoading(false);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const result = await apiFetch<{ downloads: RemoteFileDownloadJob[] }>(`${API_PATHS.server}/files/downloads`);
      setJobs(result.downloads);
      setJobsError("");
    } catch (value) {
      setJobsError(errorMessage(value));
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch<{ connections: Connection[] }>(`${API_PATHS.server}/connections`)
      .then(value => {
        if (!active) return;
        setConnections(value.connections);
        setSelectedConnectionId(current => current || value.connections[0]?.id || "");
      })
      .catch(value => {
        if (active) setError(errorMessage(value));
      })
      .finally(() => {
        if (active) setConnectionsLoading(false);
      });
    const jobsTimer = window.setTimeout(() => void loadJobs(), 0);
    return () => {
      active = false;
      window.clearTimeout(jobsTimer);
    };
  }, [loadJobs]);

  useEffect(() => {
    if (!selectedConnectionId) return;
    const timer = window.setTimeout(() => void loadDirectory(selectedConnectionId, activePath), 0);
    return () => window.clearTimeout(timer);
  }, [selectedConnectionId, activePath, loadDirectory]);

  const hasActiveJobs = useMemo(
    () => jobs.some(job => job.status === "queued" || job.status === "running"),
    [jobs],
  );

  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => void loadJobs(), 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, loadJobs]);

  const pathSegments = useMemo(() => activePath.split("/").filter(Boolean), [activePath]);
  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (directory?.entries || []).filter(entry => !normalized || `${entry.name} ${entry.path}`.toLowerCase().includes(normalized));
  }, [directory, query]);

  function changeConnection(connectionId: string) {
    if (connectionId === selectedConnectionId) return;
    lastDirectoryRequest.current = "";
    setSelectedConnectionId(connectionId);
    setActivePath("");
    setPathInput("");
    setDirectory(null);
    setDirectoryError("");
    setQuery("");
  }

  function openPath(remotePath: string) {
    if (remotePath === activePath) return;
    setQuery("");
    setActivePath(remotePath);
    setPathInput(remotePath);
  }

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openPath(pathInput.trim());
  }

  async function startDownload(entry: RemoteFileEntry) {
    if (!selectedConnectionId || entry.type !== "file") return;
    setStartingPath(entry.path);
    setError("");
    setMessage("");
    try {
      const result = await apiFetch<{ download: RemoteFileDownloadJob }>(
        `${API_PATHS.server}/files/${encodePath(selectedConnectionId)}/download`,
        { method: "POST", body: jsonBody({ path: entry.path }) },
      );
      setJobs(current => [result.download, ...current.filter(job => job.id !== result.download.id)]);
      setMessage(`已加入 SSH 拉取队列：${entry.name}`);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setStartingPath("");
    }
  }

  async function removeJob(job: RemoteFileDownloadJob) {
    if (!window.confirm(`确定删除“${job.name}”的 Hub 缓存吗？`)) return;
    try {
      await apiFetch(`${API_PATHS.server}/files/downloads/${encodePath(job.id)}`, { method: "DELETE" });
      setJobs(current => current.filter(item => item.id !== job.id));
      setMessage("已删除 Hub 缓存文件");
    } catch (value) {
      setJobsError(errorMessage(value));
    }
  }

  return (
    <>
      <PageHeader
        kicker="文件管理 / Server Files"
        title="服务器文件下载"
        description="先通过内网 SSH 把远程服务器文件拉取到 HannisHub 所在服务器，再从浏览器下载。"
        actions={<Button variant="secondary" size="sm" onClick={() => void loadJobs()}>刷新任务</Button>}
      />
      {error ? <ErrorState message={error} /> : null}
      {message ? <div className="inline-message">{message}</div> : null}
      <div className="two-column-grid">
        <Card>
          <CardHeader
            title="远端文件浏览"
            description="选择已保存的 SSH 连接，浏览远端目录；文件会先缓存到 Hub。"
          />
          {connectionsLoading ? <LoadingState label="正在读取服务器连接…" /> : connections.length ? (
            <>
              <form className="remote-file-toolbar" onSubmit={submitPath}>
                <select value={selectedConnectionId} onChange={event => changeConnection(event.target.value)} aria-label="SSH 服务器连接">
                  {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                </select>
                <input className="search-input" value={pathInput} onChange={event => setPathInput(event.target.value)} placeholder="远端绝对路径，留空进入主目录" aria-label="远端路径" />
                <Button type="submit" size="sm" disabled={directoryLoading}>打开</Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => openPath("")} disabled={directoryLoading}>主目录</Button>
                <Button type="button" variant="quiet" size="sm" onClick={() => { lastDirectoryRequest.current = ""; void loadDirectory(selectedConnectionId, activePath); }} disabled={directoryLoading}>重新读取</Button>
              </form>
              <div className="file-manager-meta">
                {directory ? (
                  <>
                    <span><Badge tone="info">SFTP</Badge> {directory.path}</span>
                    <span>最多 {directory.max_entries.toLocaleString()} 项</span>
                  </>
                ) : <span>正在定位远端目录…</span>}
              </div>
              <button className="file-manager-up" type="button" onClick={() => openPath(parentRemotePath(activePath))} disabled={!activePath || activePath === "/"}>← 返回上级</button>
              <nav className="file-manager-breadcrumb" aria-label="远端目录路径">
                <button type="button" onClick={() => openPath("/")}>/</button>
                {pathSegments.map((segment, index) => (
                  <span key={remotePathAt(pathSegments, index)}>
                    <b>/</b>
                    <button type="button" onClick={() => openPath(remotePathAt(pathSegments, index))}>{segment}</button>
                  </span>
                ))}
              </nav>
              <div className="remote-file-toolbar remote-file-filter">
                <input className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索当前目录" aria-label="搜索远端文件" />
              </div>
              {directoryLoading ? <LoadingState label="正在读取远端目录…" /> : directoryError ? <ErrorState message={directoryError} /> : filteredEntries.length ? (
                <div className="file-manager-list">
                  {filteredEntries.map(entry => (
                    <div className="file-manager-entry" key={entry.path}>
                      <button className="file-manager-entry-main" type="button" onClick={() => entry.type === "directory" ? openPath(entry.path) : undefined} disabled={entry.type !== "directory"}>
                        <span className="file-manager-entry-mark">{entry.type === "directory" ? (entry.symlink ? "⇢" : "◇") : entry.type === "file" ? "·" : "×"}</span>
                        <span className="file-manager-entry-details">
                          <strong title={entry.name}>{entry.name}</strong>
                          <small>{entry.type === "directory" ? entry.symlink ? "软链接文件夹" : "文件夹" : entry.type === "file" ? `${formatRemoteBytes(entry.size)} · ${formatDate(entry.modified)}` : "不支持的链接或特殊文件"}</small>
                        </span>
                      </button>
                      <span className="file-manager-entry-actions">
                        {entry.symlink ? <Badge tone="info">软链接</Badge> : null}
                        {entry.extension ? <Badge>.{entry.extension}</Badge> : null}
                        {entry.type === "file" ? (
                          entry.size > MAX_DOWNLOAD_BYTES ? <span className="muted-line">超过 4 GB</span> : (
                            <Button variant="secondary" size="sm" onClick={() => void startDownload(entry)} disabled={!!startingPath}>
                              {startingPath === entry.path ? "加入队列…" : "拉取到 Hub"}
                            </Button>
                          )
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              ) : <EmptyState title="没有匹配的远端文件" detail="可以返回上级目录、更换搜索词，或在上方输入远端绝对路径。" />}
              {directory?.truncated ? <div className="inline-message"><Badge tone="warning">已截断</Badge><span>远端目录条目超过 {directory.max_entries.toLocaleString()} 个，只显示前 {directory.max_entries.toLocaleString()} 项。</span></div> : null}
            </>
          ) : <EmptyState title="还没有服务器连接" detail="请先在“服务器连接”页面保存一个 SSH 入口。" />}
        </Card>

        <Card>
          <CardHeader
            title={`SSH 拉取任务 · ${jobs.length}`}
            description="任务串行执行；完成后文件会保留在 Hub，可重复下载或删除缓存。"
          />
          {jobsError ? <ErrorState message={jobsError} /> : null}
          {jobs.length ? (
            <div className="stack-list">
              {jobs.map(job => (
                <article className="download-row" key={job.id}>
                  <div>
                    <div className="connection-title">
                      <strong title={job.name}>{job.name}</strong>
                      <Badge tone={job.status === "completed" ? "success" : job.status === "failed" ? "error" : job.status === "running" ? "info" : job.status === "canceled" ? "warning" : "neutral"}>
                        {downloadStatusLabels[job.status] || job.status}
                      </Badge>
                    </div>
                    <code title={job.remote_path}>{job.remote_path}</code>
                    <span>{job.connection_name} · {formatRemoteBytes(job.size)} · {formatDate(job.created_at)}</span>
                    <ProgressBar value={job.progress} tone={job.status === "completed" ? "success" : job.status === "failed" || job.status === "canceled" ? "warning" : "brand"} />
                    <span>
                      {formatRemoteBytes(job.downloaded_bytes)} / {formatRemoteBytes(job.size)}
                      {job.status === "running" && job.speed_bytes_per_second ? ` · ${formatRemoteBytes(job.speed_bytes_per_second)}/秒` : ""}
                    </span>
                    {job.error ? <small className="error-text">{job.error}</small> : null}
                  </div>
                  <div className="download-row-end">
                    {job.status === "completed" && job.download_url ? (
                      <a className="button button-primary button-sm" href={job.download_url} download={job.name}>下载到本机</a>
                    ) : null}
                    {job.status !== "queued" && job.status !== "running" ? (
                      <Button variant="danger" size="sm" onClick={() => void removeJob(job)}>删除缓存</Button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : <EmptyState title="暂无拉取任务" detail="在左侧选择远端文件后点击“拉取到 Hub”。" />}
        </Card>
      </div>
    </>
  );
}
