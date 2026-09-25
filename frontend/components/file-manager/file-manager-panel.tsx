"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type {
  FileManagerDirectoryResponse,
  FileManagerDatePlyResponse,
  FileManagerEntry,
  FileManagerFavorite,
  FileManagerPlyResponse,
  FileManagerSyncResponse,
} from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader } from "../ui/primitives";
import { PointCloudViewer, type PointCloudSource } from "./point-cloud-viewer";

const POINT_CLOUD_EXTENSIONS = new Set(["ply", "pcd", "xyz", "xyzn", "xyzrgb", "pts", "las", "laz"]);
const VIEWABLE_EXTENSIONS = new Set(["ply", "pcd", "xyz", "xyzn", "xyzrgb", "pts"]);
const DEFAULT_DIRECTORY = "RadioGS-stage1/output";

function localDateValue(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function defaultDateRange(): { start: string; end: string } {
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  return { start: localDateValue(firstDay), end: localDateValue(today) };
}

interface SelectedFile extends PointCloudSource {
  rootIndex: number;
  path: string;
}

/** 受限目录内的文件下载地址，预览与列表下载按钮共用 */
function downloadUrl(rootIndex: number, path: string): string {
  return `${API_PATHS.fileManager}/download?${new URLSearchParams({ root: String(rootIndex), path })}`;
}

function selectedFile(rootIndex: number, path: string): SelectedFile {
  const name = path.split("/").at(-1) || path;
  return { rootIndex, path, name, format: name.split(".").at(-1)?.toLowerCase() || "", url: downloadUrl(rootIndex, path) };
}

export function FileManagerPanel({ mode }: { mode: "browser" | "point-cloud" }) {
  const router = useRouter();
  const pointCloudMode = mode === "point-cloud";
  const [roots, setRoots] = useState<string[]>([]);
  const [resolvedRoots, setResolvedRoots] = useState<string[]>([]);
  const [selectedRootIndex, setSelectedRootIndex] = useState(0);
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState<FileManagerDirectoryResponse | null>(null);
  const [plyFiles, setPlyFiles] = useState<FileManagerPlyResponse | null>(null);
  const [dateFoldersText, setDateFoldersText] = useState("");
  const [dateFoldersReady, setDateFoldersReady] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [datePreset, setDatePreset] = useState<"week" | "today" | "custom">("week");
  const [iterationMode, setIterationMode] = useState<"latest" | "exact" | "all">("latest");
  const [iterationQuery, setIterationQuery] = useState("40000");
  const [dateResults, setDateResults] = useState<FileManagerDatePlyResponse | null>(null);
  const [dateBusy, setDateBusy] = useState(false);
  const [dateError, setDateError] = useState("");
  const [query, setQuery] = useState("");
  const [onlyPointClouds, setOnlyPointClouds] = useState(false);
  const [previewFile, setPreviewFile] = useState<SelectedFile | null>(null);
  const [favorites, setFavorites] = useState<FileManagerFavorite[]>([]);
  const [favoriteError, setFavoriteError] = useState("");
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [editName, setEditName] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncTarget, setSyncTarget] = useState("all");
  const [syncMessage, setSyncMessage] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const dateRequestId = useRef(0);
  const initialDateSearchStarted = useRef(false);
  const directoryCache = useRef(new Map<string, FileManagerDirectoryResponse>());
  const plyCache = useRef(new Map<string, FileManagerPlyResponse>());

  const loadDirectory = useCallback(async (rootIndex: number, nextPath: string, refresh = false) => {
    const currentRequest = ++requestId.current;
    const key = `${rootIndex}:${nextPath}`;
    const cached = directoryCache.current.get(key);
    const cachedPly = pointCloudMode ? plyCache.current.get(key) : null;
    if (!refresh && cached && cached.expires_at > Date.now() / 1000 && (!pointCloudMode || (cachedPly && cachedPly.expires_at > Date.now() / 1000))) {
      setDirectory(cached);
      if (pointCloudMode) setPlyFiles(cachedPly || null);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setDirectory(null);
    if (pointCloudMode) setPlyFiles(null);
    try {
      const separator = refresh ? "&refresh=true" : "";
      const directoryRequest = apiFetch<FileManagerDirectoryResponse>(`${API_PATHS.fileManager}/directory?root=${rootIndex}&path=${encodeURIComponent(nextPath)}${separator}`);
      const plyRequest = pointCloudMode ? apiFetch<FileManagerPlyResponse>(`${API_PATHS.fileManager}/ply-files?root=${rootIndex}&path=${encodeURIComponent(nextPath)}`) : Promise.resolve(null);
      const [data, plyData] = await Promise.all([directoryRequest, plyRequest]);
      if (currentRequest !== requestId.current) return;
      directoryCache.current.set(key, data);
      if (plyData) plyCache.current.set(key, plyData);
      setDirectory(data);
      if (pointCloudMode) setPlyFiles(plyData);
      setError("");
    } catch (value) {
      if (currentRequest === requestId.current) setError(errorMessage(value));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [pointCloudMode]);

  useEffect(() => {
    let active = true;
    apiFetch<{ roots: string[]; resolved_roots: string[] }>(`${API_PATHS.fileManager}/settings`)
      .then(value => {
        if (!active) return;
        const nextRoots = value.roots || [];
        setResolvedRoots(value.resolved_roots || nextRoots);
        if (pointCloudMode) {
          const params = new URLSearchParams(window.location.search);
          const requestedRoot = Number(params.get("root"));
          const requestedFile = params.get("file") || "";
          if (params.has("root") && Number.isInteger(requestedRoot) && requestedRoot >= 0 && requestedRoot < nextRoots.length && VIEWABLE_EXTENSIONS.has(requestedFile.split(".").at(-1)?.toLowerCase() || "")) {
            setSelectedRootIndex(requestedRoot);
            setPath(requestedFile.split("/").slice(0, -1).join("/"));
            setPreviewFile(selectedFile(requestedRoot, requestedFile));
          } else {
            const defaultRoot = nextRoots.findIndex(root => root === "~/reproduce" || root.endsWith("/reproduce"));
            if (defaultRoot >= 0) {
              setSelectedRootIndex(defaultRoot);
              setPath(DEFAULT_DIRECTORY);
            }
          }
        }
        setRoots(nextRoots);
        if (!nextRoots.length) setLoading(false);
      })
      .catch(value => { if (active) setError(errorMessage(value)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pointCloudMode]);

  useEffect(() => {
    if (!pointCloudMode) return;
    let active = true;
    apiFetch<{ favorites: FileManagerFavorite[] }>(`${API_PATHS.fileManager}/favorites`)
      .then(value => { if (active) setFavorites(value.favorites); })
      .catch(value => { if (active) setFavoriteError(errorMessage(value)); });
    return () => { active = false; };
  }, [pointCloudMode]);

  useEffect(() => {
    if (!pointCloudMode) return;
    const timer = window.setTimeout(() => {
      const range = defaultDateRange();
      setStartDate(range.start);
      setEndDate(range.end);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pointCloudMode]);

  useEffect(() => {
    if (!pointCloudMode) return;
    let active = true;
    apiFetch<{ folders: string[] }>(`${API_PATHS.fileManager}/date-search-folders`)
      .then(value => { if (active) { setDateFoldersText(value.folders.join("\n")); setDateFoldersReady(true); } })
      .catch(value => { if (active) setDateError(errorMessage(value)); });
    return () => { active = false; };
  }, [pointCloudMode]);

  useEffect(() => {
    if (!roots.length) return;
    void loadDirectory(selectedRootIndex, path);
  }, [roots, selectedRootIndex, path, loadDirectory]);

  const filteredEntries = useMemo(() => {
    if (pointCloudMode) return [
      ...(directory?.entries.filter(entry => entry.type === "directory") || []),
      ...(plyFiles?.entries || []),
    ];
    const normalized = query.trim().toLowerCase();
    return (directory?.entries || []).filter(entry => {
      if (onlyPointClouds && !(entry.type === "directory" || POINT_CLOUD_EXTENSIONS.has(entry.extension))) return false;
      return !normalized || `${entry.name} ${entry.path}`.toLowerCase().includes(normalized);
    });
  }, [directory, plyFiles, pointCloudMode, onlyPointClouds, query]);
  const pathSegments = useMemo(() => (path ? path.split("/") : []), [path]);
  const currentFavorite = favorites.find(item => item.root_path === roots[selectedRootIndex] && item.path === path);
  const previewFavorite = previewFile ? favorites
    .filter(item => item.root_path === roots[previewFile.rootIndex] && (previewFile.path.startsWith(`${item.path}/`) || item.path === ""))
    .sort((left, right) => right.path.length - left.path.length)[0] : undefined;
  const previewPath = previewFile ? `${resolvedRoots[previewFile.rootIndex] || roots[previewFile.rootIndex] || ""}/${previewFile.path}` : "";

  function goToDirectory(nextPath: string, rootIndex = selectedRootIndex) {
    if (nextPath === path && rootIndex === selectedRootIndex) return;
    setSelectedRootIndex(rootIndex);
    setQuery("");
    setPath(nextPath);
  }

  function openPreview(entry: FileManagerEntry) {
    if (!VIEWABLE_EXTENSIONS.has(entry.extension)) return;
    if (pointCloudMode) {
      setPreviewFile(selectedFile(selectedRootIndex, entry.path));
    } else {
      router.push(`/files/point-clouds?${new URLSearchParams({ root: String(selectedRootIndex), file: entry.path })}`);
    }
  }

  function pathAt(index: number) {
    return pathSegments.slice(0, index + 1).join("/");
  }

  async function updateFavorites(request: Promise<{ favorites: FileManagerFavorite[] }>) {
    setFavoriteBusy(true);
    setFavoriteError("");
    try {
      const result = await request;
      setFavorites(result.favorites);
      setEditingId("");
    } catch (value) {
      setFavoriteError(errorMessage(value));
    } finally {
      setFavoriteBusy(false);
    }
  }

  function addCurrentFavorite() {
    void updateFavorites(apiFetch(`${API_PATHS.fileManager}/favorites`, { method: "POST", body: jsonBody({ root: selectedRootIndex, path }) }));
  }

  function saveFavoriteName() {
    if (!editingId || !editName.trim()) return;
    void updateFavorites(apiFetch(`${API_PATHS.fileManager}/favorites/${encodeURIComponent(editingId)}`, { method: "PATCH", body: jsonBody({ name: editName.trim() }) }));
  }

  function removeFavorite(id: string) {
    void updateFavorites(apiFetch(`${API_PATHS.fileManager}/favorites/${encodeURIComponent(id)}`, { method: "DELETE" }));
  }

  async function syncCache() {
    setSyncing(true);
    setSyncMessage("");
    try {
      const targets = syncTarget === "all" ? ["RadioGS-perlight", "RadioGS-stage1"] : [syncTarget];
      const result = await apiFetch<FileManagerSyncResponse>(`${API_PATHS.fileManager}/sync`, { method: "POST", body: jsonBody({ targets }) });
      directoryCache.current.clear();
      plyCache.current.clear();
      await loadDirectory(selectedRootIndex, path, true);
      setSyncMessage(`已缓存 ${result.directory_count.toLocaleString()} 个目录`);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSyncing(false);
    }
  }

  const searchDate = useCallback(async (saveFolders: boolean) => {
    initialDateSearchStarted.current = true;
    const currentRequest = ++dateRequestId.current;
    const folders = dateFoldersText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    setDateBusy(true);
    setDateError("");
    setDateResults(null);
    try {
      if (saveFolders) {
        const saved = await apiFetch<{ folders: string[] }>(`${API_PATHS.fileManager}/date-search-folders`, {
          method: "PUT", body: jsonBody({ folders }),
        });
        if (currentRequest === dateRequestId.current) setDateFoldersText(saved.folders.join("\n"));
      }
      const result = await apiFetch<FileManagerDatePlyResponse>(`${API_PATHS.fileManager}/ply-by-date`, {
        method: "POST", body: jsonBody({ start_date: startDate, end_date: endDate, iteration_mode: iterationMode,
          iteration: iterationMode === "exact" ? Number(iterationQuery) : null, refresh: saveFolders }),
      });
      if (currentRequest === dateRequestId.current) setDateResults(result);
    } catch (value) {
      if (currentRequest === dateRequestId.current) setDateError(errorMessage(value));
    } finally {
      if (currentRequest === dateRequestId.current) setDateBusy(false);
    }
  }, [dateFoldersText, startDate, endDate, iterationMode, iterationQuery]);

  useEffect(() => {
    if (!pointCloudMode || !dateFoldersReady || !startDate || !endDate || initialDateSearchStarted.current) return;
    const timer = window.setTimeout(() => {
      if (dateFoldersText.trim()) void searchDate(false);
      else initialDateSearchStarted.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pointCloudMode, dateFoldersReady, startDate, endDate, dateFoldersText, searchDate]);

  function invalidateDateResults() {
    dateRequestId.current += 1;
    setDateBusy(false);
    setDateResults(null);
  }

  function selectDatePreset(preset: "week" | "today") {
    const today = new Date();
    const start = preset === "today" ? today : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    setStartDate(localDateValue(start));
    setEndDate(localDateValue(today));
    setDatePreset(preset);
    invalidateDateResults();
  }

  function previewDateFile(rootIndex: number, filePath: string) {
    setPreviewFile(selectedFile(rootIndex, filePath));
    window.requestAnimationFrame(() => document.querySelector(".file-manager-preview")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <>
      {!pointCloudMode ? <PageHeader kicker="文件管理 / Files" title="文件游览" description="浏览已开放的目录，选择点云文件后进入预览。" /> : null}
      {error ? <ErrorState message={error} /> : null}
      <div className="file-manager-workspace">
        {pointCloudMode ? <>
          <Card className="file-manager-date-search">
            <CardHeader title="按日期查找 PLY" description="默认查看近 7 天，并显示每组点云的最新迭代。" />
            <form onSubmit={event => { event.preventDefault(); void searchDate(true); }}>
              <div className="file-manager-date-presets" aria-label="常用日期范围">
                <button type="button" aria-pressed={datePreset === "week"} onClick={() => selectDatePreset("week")}>近 7 天</button>
                <button type="button" aria-pressed={datePreset === "today"} onClick={() => selectDatePreset("today")}>今天</button>
              </div>
              <div className="file-manager-date-controls">
                <label>开始日期<input type="date" value={startDate} onChange={event => { setStartDate(event.target.value); setDatePreset("custom"); invalidateDateResults(); }} required /></label>
                <label>结束日期<input type="date" value={endDate} onChange={event => { setEndDate(event.target.value); setDatePreset("custom"); invalidateDateResults(); }} required /></label>
                <label>迭代过滤<select value={iterationMode} onChange={event => { setIterationMode(event.target.value as "latest" | "exact" | "all"); invalidateDateResults(); }}>
                  <option value="latest">每组最新迭代</option><option value="exact">指定迭代</option><option value="all">全部 PLY</option>
                </select></label>
                {iterationMode === "exact" ? <label>迭代次数<input type="number" min="0" step="1" value={iterationQuery} onChange={event => { setIterationQuery(event.target.value); invalidateDateResults(); }} required /></label> : null}
                <Button variant="secondary" size="sm" type="submit" disabled={dateBusy || !dateFoldersText.trim() || !startDate || !endDate}>{dateBusy ? "正在查找…" : "查找 PLY"}</Button>
              </div>
              <details className="file-manager-date-folder-settings"><summary>探查位置 · {dateFoldersText.split(/\r?\n/).filter(value => value.trim()).length} 个文件夹</summary>
                <label className="file-manager-date-folders">每行一个绝对路径或 ~/ 路径
                  <textarea value={dateFoldersText} onChange={event => { setDateFoldersText(event.target.value); invalidateDateResults(); }} rows={4} placeholder="~/reproduce/RadioGS-stage1" spellCheck={false} />
                </label>
              </details>
            </form>
            <p className="file-manager-date-hint">按实验文件夹名开头的日期查找，例如 0921-05-…。路径在查找时保存到服务端，须位于已开放目录内。</p>
            {dateError ? <ErrorState message={dateError} /> : null}
            {dateResults ? <>
              <div className="file-manager-date-summary">{dateResults.start_date} 至 {dateResults.end_date} · 找到 {dateResults.entries.length} 个 PLY · {dateResults.cached ? "使用目录缓存" : "已扫描目录"}</div>
              {dateResults.entries.length ? <div className="file-manager-date-results">
                {dateResults.entries.map(entry => {
                  const fullPath = `${resolvedRoots[entry.root_index] || roots[entry.root_index]}/${entry.path}`;
                  return <div className={`file-manager-date-result${previewFile?.rootIndex === entry.root_index && previewFile.path === entry.path ? " is-selected" : ""}`} key={`${entry.root_index}:${entry.path}`}>
                    <div className="file-manager-date-result-info"><strong>{entry.experiment_date} · {entry.date_folder}{entry.iteration_number !== null ? ` · iter ${entry.iteration_number}` : ""}</strong><code title={fullPath}>{fullPath}</code><small>{formatBytes(entry.size)} · {formatDate(entry.modified)}</small></div>
                    <div className="file-manager-entry-actions">
                      <Button variant="secondary" size="sm" type="button" onClick={() => previewDateFile(entry.root_index, entry.path)}>预览</Button>
                      <a className="button button-secondary button-sm" href={downloadUrl(entry.root_index, entry.path)} download title={`下载 ${entry.name}`}>下载</a>
                    </div>
                  </div>;
                })}
              </div> : <EmptyState title="所选日期没有匹配的 PLY" detail="可扩大日期范围，或将迭代过滤改为“全部 PLY”。" />}
            </> : null}
          </Card>
          <Card className={`file-manager-preview${expanded ? " is-expanded" : ""}${previewFile ? "" : " is-empty"}`}>
            {previewFile ? <PointCloudViewer key={`${previewFile.rootIndex}:${previewFile.path}`} file={previewFile} filePath={previewPath} favoriteName={previewFavorite?.name} expanded={expanded} onToggleExpanded={() => setExpanded(value => !value)} />
              : <div className="point-cloud-canvas-wrap point-cloud-empty"><EmptyState title="选择点云文件" detail="从上方日期结果选择 PLY，或从下方文件夹探查。" /></div>}
          </Card>
          <Card className="file-manager-favorites">
            <CardHeader title="收藏目录" actions={<Button variant="secondary" size="sm" onClick={() => currentFavorite ? (setEditingId(currentFavorite.id), setEditName(currentFavorite.name)) : addCurrentFavorite()} disabled={!roots.length || !directory || loading || favoriteBusy}>{currentFavorite ? "修改当前目录名称" : "收藏当前目录"}</Button>} />
            {favoriteError ? <ErrorState message={favoriteError} /> : null}
            {favorites.length ? <div className="file-manager-favorite-list">
              {favorites.map(favorite => {
                const rootIndex = roots.indexOf(favorite.root_path);
                return <div className={`file-manager-favorite${favorite.id === currentFavorite?.id ? " is-selected" : ""}`} key={favorite.id}>
                  {editingId === favorite.id ? <form className="file-manager-favorite-edit" onSubmit={event => { event.preventDefault(); saveFavoriteName(); }}>
                    <input className="search-input" value={editName} maxLength={80} autoFocus onChange={event => setEditName(event.target.value)} aria-label="收藏名称" disabled={favoriteBusy} />
                    <Button variant="secondary" size="sm" type="submit" disabled={!editName.trim() || favoriteBusy}>保存</Button>
                    <Button variant="quiet" size="sm" type="button" onClick={() => setEditingId("")} disabled={favoriteBusy}>取消</Button>
                  </form> : <>
                    <button className="file-manager-favorite-main" type="button" onClick={() => goToDirectory(favorite.path, rootIndex)} disabled={rootIndex < 0} title={`${favorite.root_path}/${favorite.path}`}><strong>{favorite.name}</strong><small>{favorite.root_path}/{favorite.path}</small></button>
                    <div className="file-manager-favorite-actions">
                      <Button variant="quiet" size="sm" onClick={() => { setEditingId(favorite.id); setEditName(favorite.name); }}>改名</Button>
                      <Button variant="quiet" size="sm" onClick={() => removeFavorite(favorite.id)} disabled={favoriteBusy}>移除</Button>
                    </div>
                  </>}
                </div>;
              })}
            </div> : <p className="file-manager-favorites-empty">收藏常用目录后，可以从这里快速跳转并修改显示名称。</p>}
          </Card>
        </> : null}
        <Card className="file-manager-browser">
          <CardHeader
            title={pointCloudMode ? directory ? `按文件夹探查 · ${filteredEntries.length}` : "按文件夹探查" : directory ? `当前目录 · ${filteredEntries.length}` : "当前目录"}
            description={directory ? directory.path.split("/").at(-1) || directory.root_path : "读取已开放的顶层目录。"}
            actions={
              <div className={`file-manager-toolbar${pointCloudMode ? " is-point-cloud" : ""}`}>
                {!pointCloudMode ? <>
                  <select value={selectedRootIndex} onChange={event => goToDirectory("", Number(event.target.value))} aria-label="顶层文件夹" disabled={!roots.length}>
                    {roots.map((root, index) => <option value={index} key={root}>{root}</option>)}
                  </select>
                  <input className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索当前目录" />
                  <button className="file-manager-filter" type="button" aria-pressed={onlyPointClouds} onClick={() => setOnlyPointClouds(value => !value)}>仅点云</button>
                </> : null}
                <select value={syncTarget} onChange={event => setSyncTarget(event.target.value)} aria-label="同步范围" disabled={syncing}>
                  <option value="all">同步两个项目</option>
                  <option value="RadioGS-perlight">RadioGS-perlight</option>
                  <option value="RadioGS-stage1">RadioGS-stage1</option>
                </select>
                <Button variant="secondary" size="sm" onClick={() => void syncCache()} disabled={syncing || !roots.length}>{syncing ? "正在同步…" : "同步目录"}</Button>
              </div>
            }
          />
          <div className="file-manager-meta">
            {directory ? (
              <>
                <span><Badge tone={directory.cached ? "success" : "info"}>{directory.cached ? "缓存" : "已同步"}</Badge> {formatDate(directory.generated_at)}</span>
                <span>{directory.cache_ttl_seconds / 60} 分钟缓存</span>
                <span>最多 {directory.max_entries} 项</span>
                {syncMessage ? <span>{syncMessage}</span> : null}
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
                <div className={`file-manager-entry${pointCloudMode && entry.type === "file" ? " is-recursive-ply" : ""}${previewFile?.rootIndex === selectedRootIndex && previewFile.path === entry.path ? " is-selected" : ""}`} key={entry.path}>
                  <button className="file-manager-entry-main" type="button" onClick={() => entry.type === "directory" ? goToDirectory(entry.path) : openPreview(entry)} disabled={entry.type !== "directory" && (entry.type !== "file" || !VIEWABLE_EXTENSIONS.has(entry.extension))}>
                    <span className="file-manager-entry-mark">{entry.type === "directory" ? "◇" : entry.type === "file" ? "·" : "×"}</span>
                    <span className="file-manager-entry-details">
                      <strong title={entry.name}>{entry.name}</strong>
                      {pointCloudMode && entry.type === "file" ? <span className="file-manager-entry-relative" title={entry.relative_path}>{entry.relative_path}</span> : null}
                      <small>
                        {entry.type === "directory" ? "文件夹" : entry.type === "file" ? `${formatBytes(entry.size)} · ${formatDate(entry.modified)}` : "不支持的链接或特殊文件"}
                      </small>
                    </span>
                  </button>
                  <span className="file-manager-entry-actions">
                    {entry.extension ? <Badge tone={POINT_CLOUD_EXTENSIONS.has(entry.extension) ? "success" : "neutral"}>.{entry.extension}</Badge> : null}
                    {entry.type === "file" && VIEWABLE_EXTENSIONS.has(entry.extension) ? <button className="button button-secondary button-sm" type="button" onClick={() => openPreview(entry)}>预览</button> : null}
                    {entry.type === "file" && POINT_CLOUD_EXTENSIONS.has(entry.extension) && !VIEWABLE_EXTENSIONS.has(entry.extension) ? <span className="muted-line">暂不支持预览</span> : null}
                    {pointCloudMode && entry.type === "file" && POINT_CLOUD_EXTENSIONS.has(entry.extension) ? <a className="button button-secondary button-sm" href={downloadUrl(selectedRootIndex, entry.path)} download title={`下载 ${entry.name}`} aria-label={`下载 ${entry.name}`}>下载</a> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : <EmptyState title={roots.length ? pointCloudMode ? "此目录没有文件夹或 PLY 文件" : "没有匹配的文件" : "没有已暴露的目录"} detail={roots.length ? pointCloudMode ? "可以返回上级目录，或选择其他收藏目录。" : "尝试更换搜索词，或取消“仅点云”过滤。" : "服务端尚未配置可浏览目录。"} />}
          {directory?.truncated ? <div className="inline-message"><Badge tone="warning">已截断</Badge><span>当前目录条目超过 {directory.max_entries} 个，只显示前 {directory.max_entries} 项。</span></div> : null}
        </Card>
      </div>
    </>
  );
}
