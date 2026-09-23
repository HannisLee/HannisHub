"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type {
  FileManagerDirectoryResponse,
  FileManagerEntry,
  FileManagerSyncResponse,
} from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";
import { PointCloudViewer } from "./point-cloud-viewer";

const POINT_CLOUD_EXTENSIONS = new Set(["ply", "pcd", "xyz", "xyzn", "xyzrgb", "pts", "las", "laz"]);
const VIEWABLE_EXTENSIONS = new Set(["ply", "pcd", "xyz", "xyzn", "xyzrgb", "pts"]);

export function FileManagerPanel() {
  const [roots, setRoots] = useState<string[]>([]);
  const [rootsText, setRootsText] = useState("");
  const [selectedRootIndex, setSelectedRootIndex] = useState(0);
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState<FileManagerDirectoryResponse | null>(null);
  const [query, setQuery] = useState("");
  const [onlyPointClouds, setOnlyPointClouds] = useState(false);
  const [previewPath, setPreviewPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const loadDirectory = useCallback(async (rootIndex: number, nextPath: string, refresh = false) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const separator = refresh ? "&refresh=true" : "";
      const data = await apiFetch<FileManagerDirectoryResponse>(`${API_PATHS.fileManager}/directory?root=${rootIndex}&path=${encodeURIComponent(nextPath)}${separator}`);
      if (currentRequest !== requestId.current) return;
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
        setRoots(value.roots || []);
        setRootsText((value.roots || []).join("\n"));
      })
      .catch(value => { if (active) setError(errorMessage(value)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!roots.length) return;
    const timer = window.setTimeout(() => void loadDirectory(selectedRootIndex, path), 0);
    return () => window.clearTimeout(timer);
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
    setPreviewPath("");
    setPath(nextPath);
  }

  function pathAt(index: number) {
    return pathSegments.slice(0, index + 1).join("/");
  }

  async function syncCache() {
    setSyncing(true);
    try {
      await apiFetch<FileManagerSyncResponse>(`${API_PATHS.fileManager}/sync`, { method: "POST" });
      await loadDirectory(selectedRootIndex, path, true);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSyncing(false);
    }
  }

  async function saveRoots() {
    const nextRoots = rootsText.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    setSaving(true);
    try {
      const value = await apiFetch<{ roots: string[] }>(`${API_PATHS.fileManager}/settings`, {
        method: "PUT",
        body: jsonBody({ roots: nextRoots }),
      });
      setRoots(value.roots || []);
      setRootsText((value.roots || []).join("\n"));
      setSelectedRootIndex(0);
      setPath("");
      setPreviewPath("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        kicker="文件管理 / Files"
        title="文件浏览与点云预览"
        description="浏览已暴露的文件夹，点击点云文件即可预览；目录列表短时间内使用缓存，需要最新状态时可手动同步。"
        actions={<Button variant="secondary" onClick={() => void syncCache()} disabled={syncing || !roots.length}>{syncing ? "正在同步…" : "同步目录"}</Button>}
      />
      {error ? <ErrorState message={error} /> : null}
      <div className="stack-grid">
        <Card>
          <CardHeader
            title="暴露范围"
            description="每行填写一个顶层文件夹。文件浏览、点云预览和下载都会受到这些目录限制；支持以 ~/ 开头的路径。"
          />
          <div className="file-manager-settings">
            <Field label="顶层文件夹">
              <textarea className="file-manager-roots" value={rootsText} onChange={event => setRootsText(event.target.value)} placeholder="~/reproduce" spellCheck={false} />
            </Field>
            <div className="form-actions">
              <Button onClick={() => void saveRoots()} disabled={saving}>{saving ? "保存中…" : "保存范围"}</Button>
              <span className="muted-line">默认只暴露 ~/reproduce；保存空列表会暂时关闭文件暴露。</span>
            </div>
          </div>
        </Card>

        <div className="file-manager-workspace"><Card className="file-manager-browser">
          <CardHeader
            title={directory ? `当前目录 · ${filteredEntries.length}` : "当前目录"}
            description={directory ? `${directory.root_path}${directory.path ? ` / ${directory.path}` : ""}` : "读取已暴露的顶层目录。"}
            actions={
              <div className="file-manager-toolbar">
                <select value={selectedRootIndex} onChange={event => { setSelectedRootIndex(Number(event.target.value)); setPath(""); setPreviewPath(""); }} aria-label="顶层文件夹">
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
          <nav className="file-manager-breadcrumb" aria-label="目录路径">
            <button type="button" onClick={() => goToDirectory("")}>{roots[selectedRootIndex]?.split("/").filter(Boolean).at(-1) || "顶层目录"}</button>
            {pathSegments.map((segment, index) => <span key={pathAt(index)}><b>/</b><button type="button" onClick={() => goToDirectory(pathAt(index))}>{segment}</button></span>)}
          </nav>

          {loading ? <LoadingState label="正在读取目录…" /> : !roots.length ? <EmptyState title="没有已暴露的文件夹" detail="先在上方保存至少一个存在的顶层目录。" /> : filteredEntries.length ? (
            <div className="file-manager-list">
              {filteredEntries.map((entry: FileManagerEntry) => (
                <div className={`file-manager-entry${previewPath === entry.path ? " is-selected" : ""}`} key={entry.path}>
                  <button className="file-manager-entry-main" type="button" onClick={() => entry.type === "directory" ? goToDirectory(entry.path) : setPreviewPath(entry.path)} disabled={entry.type !== "directory" && (entry.type !== "file" || !VIEWABLE_EXTENSIONS.has(entry.extension))}>
                    <span className="file-manager-entry-mark">{entry.type === "directory" ? "◇" : entry.type === "file" ? "·" : "×"}</span>
                    <span>
                      <strong>{entry.name}</strong>
                      <small>
                        {entry.type === "directory" ? "文件夹" : entry.type === "file" ? `${formatBytes(entry.size)} · ${formatDate(entry.modified)}` : "不支持的链接或特殊文件"}
                      </small>
                    </span>
                  </button>
                  <span className="file-manager-entry-actions">
                    {entry.extension ? <Badge tone={POINT_CLOUD_EXTENSIONS.has(entry.extension) ? "success" : "neutral"}>.{entry.extension}</Badge> : null}
                    {entry.type === "file" && VIEWABLE_EXTENSIONS.has(entry.extension) ? <button className="button button-secondary button-sm" type="button" onClick={() => setPreviewPath(entry.path)}>预览</button> : null}
                    {entry.type === "file" && POINT_CLOUD_EXTENSIONS.has(entry.extension) && !VIEWABLE_EXTENSIONS.has(entry.extension) ? <span className="muted-line">需转换后预览</span> : null}
                    {entry.download_url ? <a className="button button-secondary button-sm" href={entry.download_url} download>下载</a> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : <EmptyState title="没有匹配的文件" detail="尝试更换搜索词，或取消“仅点云”过滤。" />}
          {directory?.truncated ? <div className="inline-message"><Badge tone="warning">已截断</Badge><span>当前目录条目超过 {directory.max_entries} 个，只显示前 {directory.max_entries} 项。</span></div> : null}
        </Card>
        <Card className="file-manager-preview">
          {previewSource ? <>
            <CardHeader eyebrow="点云预览" title={previewSource.name} description={`${directory?.root_path} / ${previewPath}`} />
            <PointCloudViewer key={`${selectedRootIndex}:${previewPath}`} file={previewSource} />
          </> : <EmptyState title="选择点云文件" detail="在左侧浏览文件夹，打开 PLY、PCD、XYZ、XYZN、XYZRGB 或 PTS 文件。LAS/LAZ 文件可下载后转换。" />}
        </Card></div>
      </div>
    </>
  );
}
