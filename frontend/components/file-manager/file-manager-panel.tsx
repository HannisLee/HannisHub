"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_PATHS, apiFetch } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type {
  FileManagerDirectoryResponse,
  FileManagerEntry,
  FileManagerSyncResponse,
} from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader } from "../ui/primitives";
import { PointCloudViewer } from "./point-cloud-viewer";

const POINT_CLOUD_EXTENSIONS = new Set(["ply", "pcd", "xyz", "xyzn", "xyzrgb", "pts", "las", "laz"]);
const VIEWABLE_EXTENSIONS = new Set(["ply", "pcd", "xyz", "xyzn", "xyzrgb", "pts"]);
const DEFAULT_DIRECTORY = "RadioGS-stage1/output/0921-05-cv3-d4rt-48clip-depth-normal/point_cloud/iteration_40000";
const DEFAULT_FILE = `${DEFAULT_DIRECTORY}/point_cloud.ply`;

export function FileManagerPanel() {
  const [roots, setRoots] = useState<string[]>([]);
  const [selectedRootIndex, setSelectedRootIndex] = useState(0);
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState<FileManagerDirectoryResponse | null>(null);
  const [query, setQuery] = useState("");
  const [onlyPointClouds, setOnlyPointClouds] = useState(false);
  const [previewPath, setPreviewPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const directoryCache = useRef(new Map<string, FileManagerDirectoryResponse>());

  const loadDirectory = useCallback(async (rootIndex: number, nextPath: string, refresh = false) => {
    const currentRequest = ++requestId.current;
    const key = `${rootIndex}:${nextPath}`;
    const cached = directoryCache.current.get(key);
    if (!refresh && cached && cached.expires_at > Date.now() / 1000) {
      setDirectory(cached);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    try {
      const separator = refresh ? "&refresh=true" : "";
      const data = await apiFetch<FileManagerDirectoryResponse>(`${API_PATHS.fileManager}/directory?root=${rootIndex}&path=${encodeURIComponent(nextPath)}${separator}`);
      if (currentRequest !== requestId.current) return;
      directoryCache.current.set(key, data);
      setDirectory(data);
      setError("");
    } catch (value) {
      if (currentRequest === requestId.current) setError(errorMessage(value));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch<{ roots: string[] }>(`${API_PATHS.fileManager}/settings`)
      .then(value => {
        if (!active) return;
        const nextRoots = value.roots || [];
        const defaultRoot = nextRoots.findIndex(root => root === "~/reproduce" || root.endsWith("/reproduce"));
        if (defaultRoot >= 0) {
          setSelectedRootIndex(defaultRoot);
          setPath(DEFAULT_DIRECTORY);
          setPreviewPath(DEFAULT_FILE);
        }
        setRoots(nextRoots);
        if (!nextRoots.length) setLoading(false);
      })
      .catch(value => { if (active) setError(errorMessage(value)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!roots.length) return;
    void loadDirectory(selectedRootIndex, path);
  }, [roots, selectedRootIndex, path, loadDirectory]);

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (directory?.entries || []).filter(entry => {
      if (onlyPointClouds && !(entry.type === "directory" || POINT_CLOUD_EXTENSIONS.has(entry.extension))) return false;
      return !normalized || `${entry.name} ${entry.path}`.toLowerCase().includes(normalized);
    });
  }, [directory, onlyPointClouds, query]);
  const previewEntry = directory?.entries.find(entry => entry.path === previewPath && entry.type === "file" && VIEWABLE_EXTENSIONS.has(entry.extension));
  const previewSource = useMemo(() => previewEntry?.download_url ? { name: previewEntry.name, format: previewEntry.extension, url: previewEntry.download_url } : null, [previewEntry]);

  const pathSegments = useMemo(() => (path ? path.split("/") : []), [path]);

  function goToDirectory(nextPath: string) {
    if (nextPath === path) return;
    const root = roots[selectedRootIndex];
    setQuery("");
    setPreviewPath(nextPath === DEFAULT_DIRECTORY && (root === "~/reproduce" || root?.endsWith("/reproduce")) ? DEFAULT_FILE : "");
    setPath(nextPath);
  }

  function pathAt(index: number) {
    return pathSegments.slice(0, index + 1).join("/");
  }

  async function syncCache() {
    setSyncing(true);
    try {
      await apiFetch<FileManagerSyncResponse>(`${API_PATHS.fileManager}/sync`, { method: "POST" });
      directoryCache.current.clear();
      await loadDirectory(selectedRootIndex, path, true);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <PageHeader
        kicker="文件管理 / Files"
        title="文件浏览与点云预览"
        description="浏览文件夹并直接预览点云；默认打开指定的点云文件。"
        actions={<Button variant="secondary" onClick={() => void syncCache()} disabled={syncing || !roots.length}>{syncing ? "正在同步…" : "同步目录"}</Button>}
      />
      {error ? <ErrorState message={error} /> : null}
      <div className="stack-grid">
        <div className="file-manager-workspace">
        <Card className={`file-manager-preview${expanded ? " is-expanded" : ""}`}>
          {previewSource ? <>
            <CardHeader eyebrow="点云预览" title={previewSource.name} actions={<Button variant="secondary" size="sm" onClick={() => setExpanded(value => !value)}>{expanded ? "退出大屏" : "放大预览"}</Button>} />
            <PointCloudViewer key={`${selectedRootIndex}:${previewPath}`} file={previewSource} />
          </> : <EmptyState title="选择点云文件" detail="在下方浏览文件夹，打开 PLY、PCD、XYZ、XYZN、XYZRGB 或 PTS 文件。" />}
        </Card>
        <Card className="file-manager-browser">
          <CardHeader
            title={directory ? `当前目录 · ${filteredEntries.length}` : "当前目录"}
            description={directory ? directory.path.split("/").at(-1) || directory.root_path : "读取已暴露的顶层目录。"}
            actions={
              <div className="file-manager-toolbar">
                <select value={selectedRootIndex} onChange={event => { setSelectedRootIndex(Number(event.target.value)); setPath(""); setPreviewPath(""); setQuery(""); }} aria-label="顶层文件夹" disabled={!roots.length}>
                  {roots.map((root, index) => <option value={index} key={root}>{root}</option>)}
                </select>
                <input className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索当前目录" />
                <button className="file-manager-filter" type="button" aria-pressed={onlyPointClouds} onClick={() => setOnlyPointClouds(value => !value)}>仅点云</button>
              </div>
            }
          />
          <div className="file-manager-meta">
            {directory ? (
              <>
                <span><Badge tone={directory.cached ? "success" : "info"}>{directory.cached ? "缓存" : "已同步"}</Badge> {formatDate(directory.generated_at)}</span>
                <span>{directory.cache_ttl_seconds} 秒缓存</span>
                <span>最多 {directory.max_entries} 项</span>
              </>
            ) : <span>正在读取目录状态…</span>}
          </div>
          <button className="file-manager-up" type="button" onClick={() => goToDirectory(pathSegments.slice(0, -1).join("/"))} disabled={!path}>← 返回上级</button>
          <nav className="file-manager-breadcrumb" aria-label="目录路径">
            <button type="button" onClick={() => goToDirectory("")}>{roots[selectedRootIndex]?.split("/").filter(Boolean).at(-1) || "顶层目录"}</button>
            {pathSegments.map((segment, index) => <span key={pathAt(index)}><b>/</b><button type="button" onClick={() => goToDirectory(pathAt(index))}>{segment}</button></span>)}
          </nav>

          {loading ? <LoadingState label="正在读取目录…" /> : !roots.length ? <EmptyState title="没有已暴露的文件夹" detail="请在服务端配置可浏览目录。" /> : filteredEntries.length ? (
            <div className="file-manager-list">
              {filteredEntries.map((entry: FileManagerEntry) => (
                <div className={`file-manager-entry${previewPath === entry.path ? " is-selected" : ""}`} key={entry.path}>
                  <button className="file-manager-entry-main" type="button" onClick={() => entry.type === "directory" ? goToDirectory(entry.path) : setPreviewPath(entry.path)} disabled={entry.type !== "directory" && (entry.type !== "file" || !VIEWABLE_EXTENSIONS.has(entry.extension))}>
                    <span className="file-manager-entry-mark">{entry.type === "directory" ? "◇" : entry.type === "file" ? "·" : "×"}</span>
                    <span className="file-manager-entry-details">
                      <strong>{entry.name}</strong>
                      <small>
                        {entry.type === "directory" ? "文件夹" : entry.type === "file" ? `${formatBytes(entry.size)} · ${formatDate(entry.modified)}` : "不支持的链接或特殊文件"}
                      </small>
                    </span>
                  </button>
                  <span className="file-manager-entry-actions">
                    {entry.extension ? <Badge tone={POINT_CLOUD_EXTENSIONS.has(entry.extension) ? "success" : "neutral"}>.{entry.extension}</Badge> : null}
                    {entry.type === "file" && VIEWABLE_EXTENSIONS.has(entry.extension) ? <button className="button button-secondary button-sm" type="button" onClick={() => setPreviewPath(entry.path)}>预览</button> : null}
                    {entry.type === "file" && POINT_CLOUD_EXTENSIONS.has(entry.extension) && !VIEWABLE_EXTENSIONS.has(entry.extension) ? <span className="muted-line">暂不支持预览</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : <EmptyState title={roots.length ? "没有匹配的文件" : "没有已暴露的目录"} detail={roots.length ? "尝试更换搜索词，或取消“仅点云”过滤。" : "服务端尚未配置可浏览目录。"} />}
          {directory?.truncated ? <div className="inline-message"><Badge tone="warning">已截断</Badge><span>当前目录条目超过 {directory.max_entries} 个，只显示前 {directory.max_entries} 项。</span></div> : null}
        </Card></div>
      </div>
    </>
  );
}
