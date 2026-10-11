"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type { FileManagerDirectoryResponse, FileManagerEntry, FileManagerFavorite, MarkdownDocument } from "../../lib/types";
import { Button, EmptyState, ErrorState, LoadingState } from "../ui/primitives";

type MarkdownLinkHandler = (path: string) => void;

const DEFAULT_DOCUMENT_FOLDER = "/home/lihan/reproduce/RadioGS-stage1";
const DOCUMENT_LOCATION_KEY = "hannishub_document_viewer_location";
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkdn"]);

interface SavedDocumentLocation {
  root: string;
  folder: string;
  document: string;
}

/** 读取并校验文档页上次浏览位置；顶层目录按展开后的真实路径匹配。 */
function readSavedDocumentLocation(storage: Pick<Storage, "getItem">, resolvedRoots: string[]): SavedDocumentLocation | null {
  try {
    const saved = JSON.parse(storage.getItem(DOCUMENT_LOCATION_KEY) || "null") as Partial<SavedDocumentLocation> | null;
    if (!saved || typeof saved.root !== "string" || typeof saved.folder !== "string" || typeof saved.document !== "string") return null;
    const rootIndex = resolvedRoots.indexOf(saved.root);
    if (rootIndex < 0) return null;
    const folderParts = saved.folder ? saved.folder.split("/") : [];
    const documentParts = saved.document ? saved.document.split("/") : [];
    if (folderParts.some(part => !part || part === "." || part === "..") || documentParts.some(part => !part || part === "." || part === "..")) return null;
    if (saved.document && saved.document.split("/").slice(0, -1).join("/") !== saved.folder) return null;
    return { root: resolvedRoots[rootIndex], folder: saved.folder, document: saved.document };
  } catch {
    return null;
  }
}

function isMarkdownFile(entry: FileManagerEntry): boolean {
  return entry.type === "file" && MARKDOWN_EXTENSIONS.has(entry.extension);
}

function datePrefixValue(name: string): number | null {
  const match = name.match(/^(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/);
  if (!match) return null;
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(value) ? null : value;
}

function compareDocumentEntries(left: FileManagerEntry, right: FileManagerEntry): number {
  if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
  const leftDate = datePrefixValue(left.name);
  const rightDate = datePrefixValue(right.name);
  if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate;
  if (leftDate !== null && rightDate === null) return -1;
  if (rightDate !== null && leftDate === null) return 1;
  if (left.modified !== right.modified) return right.modified - left.modified;
  return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
}

function resourceUrl(rootIndex: number, path: string): string {
  return `${API_PATHS.fileManager}/resource?${new URLSearchParams({ root: String(rootIndex), path })}`;
}

function normalizeLocalReference(reference: string, sourcePath: string): string | null {
  const value = reference.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
  if (!value || value.startsWith("/") || value.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const parts = sourcePath.split("/").slice(0, -1);
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function inlineMarkdown(
  value: string,
  rootIndex: number,
  sourcePath: string,
  onOpenMarkdown: MarkdownLinkHandler,
  keyPrefix: string,
): ReactNode[] {
  const tokenPattern = /(!?\[[^\]]*\]\((?:<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  const result: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;
  while ((match = tokenPattern.exec(value))) {
    if (match.index > cursor) result.push(value.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex++}`;
    const image = token.match(/^!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)$/);
    const link = token.match(/^\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)$/);
    if (image) {
      const imagePath = normalizeLocalReference(image[2], sourcePath);
      result.push(imagePath
        // Markdown 相对图片没有固定尺寸，保留原始比例以兼容文档资源。
        // eslint-disable-next-line @next/next/no-img-element
        ? <img className="markdown-image" key={key} src={resourceUrl(rootIndex, imagePath)} alt={image[1]} loading="lazy" />
        : <span className="markdown-missing-image" key={key}>图片：{image[1] || image[2]}</span>);
    } else if (link) {
      const localPath = normalizeLocalReference(link[2], sourcePath);
      if (localPath?.match(/\.(md|markdown|mdown|mkdn)$/i)) {
        result.push(<button className="markdown-link-button" type="button" key={key} onClick={() => onOpenMarkdown(localPath)}>{link[1]}</button>);
      } else if (localPath) {
        result.push(<a className="markdown-link" key={key} href={resourceUrl(rootIndex, localPath)} target="_blank" rel="noreferrer">{link[1]}</a>);
      } else {
        const href = link[2].replace(/^<|>$/g, "");
        result.push(<a className="markdown-link" key={key} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel={href.startsWith("#") ? undefined : "noreferrer"}>{link[1]}</a>);
      }
    } else if (token.startsWith("`")) {
      result.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      result.push(<strong key={key}>{inlineMarkdown(token.slice(2, -2), rootIndex, sourcePath, onOpenMarkdown, `${key}-strong`)}</strong>);
    } else {
      result.push(<em key={key}>{inlineMarkdown(token.slice(1, -1), rootIndex, sourcePath, onOpenMarkdown, `${key}-em`)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) result.push(value.slice(cursor));
  return result;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isBlockStart(line: string): boolean {
  return /^\s*(#{1,6}\s+|```|~~~|>\s?|[-*+]\s+|\d+\.\s+|([-*_])(?:\s*\2){2,}\s*$)/.test(line);
}

function MarkdownContent({ content, rootIndex, sourcePath, onOpenMarkdown }: {
  content: string;
  rootIndex: number;
  sourcePath: string;
  onOpenMarkdown: MarkdownLinkHandler;
}) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  if (lines[0]?.trim() === "---") {
    const ending = lines.slice(1).findIndex(line => line.trim() === "---");
    if (ending >= 0) index = ending + 2;
  }
  const inline = (text: string, key: string) => inlineMarkdown(text, rootIndex, sourcePath, onOpenMarkdown, key);

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const key = `block-${blockIndex++}`;
    const fence = line.match(/^\s*(```+|~~~+)\s*([^\s]*)/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre className="markdown-code" key={key}><code data-language={language || undefined}>{codeLines.join("\n")}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={key}>{inline(heading[2], key)}</Tag>);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{quote.map((part, quoteIndex) => <span key={`${key}-${quoteIndex}`}>{inline(part, `${key}-${quoteIndex}`)}{quoteIndex < quote.length - 1 ? <br /> : null}</span>)}</blockquote>);
      continue;
    }
    if (line.includes("|") && isTableDivider(lines[index + 1] || "")) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(splitTableRow(lines[index++]));
      blocks.push(<div className="markdown-table-wrap" key={key}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={`${key}-head-${cellIndex}`}>{inline(cell, `${key}-head-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`${key}-row-${rowIndex}`}>{headers.map((_, cellIndex) => <td key={`${key}-cell-${rowIndex}-${cellIndex}`}>{inline(row[cellIndex] || "", `${key}-cell-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const items: string[] = [];
      const pattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={key}>{items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>)}</List>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index]) && !(lines[index].includes("|") && isTableDivider(lines[index + 1] || ""))) paragraph.push(lines[index++]);
    blocks.push(<p key={key}>{paragraph.map((part, paragraphIndex) => <span key={`${key}-${paragraphIndex}`}>{inline(part, `${key}-${paragraphIndex}`)}{paragraphIndex < paragraph.length - 1 ? <br /> : null}</span>)}</p>);
  }
  return <article className="markdown-content">{blocks}</article>;
}

export function DocumentViewer() {
  const [roots, setRoots] = useState<string[]>([]);
  const [resolvedRoots, setResolvedRoots] = useState<string[]>([]);
  const [rootIndex, setRootIndex] = useState(0);
  const [folder, setFolder] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPath, setPickerPath] = useState("");
  const [pickerDirectory, setPickerDirectory] = useState<FileManagerDirectoryResponse | null>(null);
  const [directory, setDirectory] = useState<FileManagerDirectoryResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [markdownDocument, setMarkdownDocument] = useState<MarkdownDocument | null>(null);
  const [filter, setFilter] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [error, setError] = useState("");
  const [favorites, setFavorites] = useState<FileManagerFavorite[]>([]);
  const [favoriteError, setFavoriteError] = useState("");
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const restoredDirectoryRef = useRef<FileManagerDirectoryResponse | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<{ favorites: FileManagerFavorite[] }>(`${API_PATHS.fileManager}/favorites`)
      .then(value => { if (active) setFavorites(value.favorites); })
      .catch(value => { if (active) setFavoriteError(errorMessage(value)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch<{ roots: string[]; resolved_roots: string[] }>(`${API_PATHS.fileManager}/settings`)
      .then(async value => {
        if (!active) return;
        const nextRoots = value.roots || [];
        const nextResolvedRoots = value.resolved_roots || nextRoots;
        let nextRootIndex = 0;
        let nextFolder = "";
        let nextDocumentPath = "";
        let nextDirectory: FileManagerDirectoryResponse | null = null;
        let saved: SavedDocumentLocation | null = null;
        try { saved = readSavedDocumentLocation(window.localStorage, nextResolvedRoots); } catch { /* 浏览器禁用存储时使用默认目录。 */ }
        if (saved) {
          try {
            const data = await apiFetch<FileManagerDirectoryResponse>(`${API_PATHS.fileManager}/directory?${new URLSearchParams({ root: String(nextResolvedRoots.indexOf(saved.root)), path: saved.folder })}`);
            if (!active) return;
            nextRootIndex = data.root_index;
            nextFolder = data.path;
            nextDirectory = data;
            nextDocumentPath = data.entries.some(entry => entry.path === saved?.document) ? saved.document : "";
          } catch {
            // 上次目录被删除或链接失效时回退到默认目录。
          }
        }
        if (!nextDirectory) {
          const defaultRootIndex = nextResolvedRoots.findIndex(root => DEFAULT_DOCUMENT_FOLDER === root || DEFAULT_DOCUMENT_FOLDER.startsWith(`${root.replace(/\/+$/, "")}/`));
          if (defaultRootIndex >= 0) {
            const rootPath = nextResolvedRoots[defaultRootIndex].replace(/\/+$/, "");
            nextRootIndex = defaultRootIndex;
            nextFolder = DEFAULT_DOCUMENT_FOLDER.slice(rootPath.length).replace(/^\/+/, "");
          }
        }
        setRoots(nextRoots);
        setResolvedRoots(nextResolvedRoots);
        setRootIndex(nextRootIndex);
        setFolder(nextFolder);
        setSelectedPath(nextDocumentPath);
        setLoadingDocument(Boolean(nextDocumentPath));
        if (nextDirectory) {
          restoredDirectoryRef.current = nextDirectory;
          setDirectory(nextDirectory);
        }
        if (!nextRoots.length) setLoadingFiles(false);
      })
      .catch(value => { if (active) { setError(errorMessage(value)); setLoadingFiles(false); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!roots.length) return;
    if (restoredDirectoryRef.current) {
      // 初始化时已校验并取回上次目录，这里直接复用，避免同一次打开重复请求。
      const value = restoredDirectoryRef.current;
      restoredDirectoryRef.current = null;
      setDirectory(value);
      setSelectedPath(current => {
        const markdownFiles = value.entries.filter(isMarkdownFile);
        const nextPath = markdownFiles.some(entry => entry.path === current) ? current : markdownFiles.sort(compareDocumentEntries)[0]?.path || "";
        if (nextPath !== current) {
          setMarkdownDocument(null);
          setLoadingDocument(Boolean(nextPath));
        }
        return nextPath;
      });
      setError("");
      setLoadingFiles(false);
      return;
    }
    let active = true;
    apiFetch<FileManagerDirectoryResponse>(`${API_PATHS.fileManager}/directory?${new URLSearchParams({ root: String(rootIndex), path: folder })}`)
      .then(value => {
        if (!active) return;
        setDirectory(value);
        setSelectedPath(current => {
          const markdownFiles = value.entries.filter(isMarkdownFile);
          const nextPath = markdownFiles.some(entry => entry.path === current) ? current : markdownFiles.sort(compareDocumentEntries)[0]?.path || "";
          if (nextPath !== current) {
            setMarkdownDocument(null);
            setLoadingDocument(Boolean(nextPath));
          }
          return nextPath;
        });
        setError("");
      })
      .catch(value => { if (active) setError(errorMessage(value)); })
      .finally(() => { if (active) setLoadingFiles(false); });
    return () => { active = false; };
  }, [roots, rootIndex, folder]);

  useEffect(() => {
    if (!selectedPath) return;
    let active = true;
    apiFetch<MarkdownDocument>(`${API_PATHS.fileManager}/markdown?${new URLSearchParams({ root: String(rootIndex), path: selectedPath })}`)
      .then(value => { if (active) setMarkdownDocument(value); })
      .catch(value => { if (active) setError(errorMessage(value)); })
      .finally(() => { if (active) setLoadingDocument(false); });
    return () => { active = false; };
  }, [rootIndex, selectedPath]);

  useEffect(() => {
    if (!roots.length || !directory || directory.root_index !== rootIndex || directory.path !== folder || loadingDocument) return;
    const openedDocument = markdownDocument
      && markdownDocument.root_index === rootIndex
      && markdownDocument.path.split("/").slice(0, -1).join("/") === folder
      ? markdownDocument.path
      : "";
    try {
      window.localStorage.setItem(DOCUMENT_LOCATION_KEY, JSON.stringify({ root: resolvedRoots[rootIndex], folder, document: openedDocument }));
    } catch { /* 存储不可写时仅跳过记录。 */ }
  }, [roots, resolvedRoots, rootIndex, folder, directory, markdownDocument, loadingDocument]);

  useEffect(() => {
    if (!pickerOpen || !roots.length) return;
    let active = true;
    apiFetch<FileManagerDirectoryResponse>(`${API_PATHS.fileManager}/directory?${new URLSearchParams({ root: String(rootIndex), path: pickerPath })}`)
      .then(value => { if (active) setPickerDirectory(value); })
      .catch(value => { if (active) setError(errorMessage(value)); })
      .finally(() => { if (active) setLoadingPicker(false); });
    return () => { active = false; };
  }, [pickerOpen, roots, rootIndex, pickerPath]);

  const visibleEntries = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (directory?.entries || [])
      .filter(entry => entry.type === "directory" || isMarkdownFile(entry))
      .filter(entry => !query || `${entry.name} ${entry.path}`.toLowerCase().includes(query))
      .sort(compareDocumentEntries);
  }, [directory, filter]);
  const pickerFolders = useMemo(() => pickerDirectory?.entries.filter(entry => entry.type === "directory") || [], [pickerDirectory]);
  const folderLabel = `${resolvedRoots[rootIndex] || roots[rootIndex] || ""}${folder ? `/${folder}` : ""}`;
  const currentFavorite = favorites.find(item => item.root_path === roots[rootIndex] && item.path === folder);

  function chooseRoot(nextRoot: number) {
    setLoadingFiles(true);
    setDirectory(null);
    setRootIndex(nextRoot);
    setFolder("");
    setPickerPath("");
    setSelectedPath("");
    setMarkdownDocument(null);
    setFilter("");
  }

  function applyFolder() {
    setLoadingFiles(true);
    setDirectory(null);
    setFolder(pickerPath);
    setSelectedPath("");
    setMarkdownDocument(null);
    setFilter("");
    setPickerOpen(false);
  }

  function openMarkdown(path: string) {
    const parentPath = path.split("/").slice(0, -1).join("/");
    if (parentPath !== folder) openDirectory(parentPath, path);
    selectDocument(path);
    window.requestAnimationFrame(() => window.document.querySelector(".document-reader")?.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function openDirectory(path: string, documentPath = "") {
    setLoadingFiles(true);
    setDirectory(null);
    setFolder(path);
    setFilter("");
    setMarkdownDocument(null);
    setSelectedPath(documentPath);
    setLoadingDocument(Boolean(documentPath));
  }

  function selectDocument(path: string) {
    if (path === selectedPath) return;
    setLoadingDocument(true);
    setMarkdownDocument(null);
    setSelectedPath(path);
  }

  function openPicker() {
    setPickerPath(folder);
    setPickerDirectory(null);
    setLoadingPicker(true);
    setPickerOpen(true);
  }

  function changePickerPath(path: string) {
    setPickerDirectory(null);
    setLoadingPicker(true);
    setPickerPath(path);
  }

  async function updateFavorites(request: Promise<{ favorites: FileManagerFavorite[] }>) {
    setFavoriteBusy(true);
    setFavoriteError("");
    try {
      const value = await request;
      setFavorites(value.favorites);
    } catch (value) {
      setFavoriteError(errorMessage(value));
    } finally {
      setFavoriteBusy(false);
    }
  }

  function addCurrentFavorite() {
    void updateFavorites(apiFetch(`${API_PATHS.fileManager}/favorites`, { method: "POST", body: jsonBody({ root: rootIndex, path: folder }) }));
  }

  function removeFavorite(id: string) {
    void updateFavorites(apiFetch(`${API_PATHS.fileManager}/favorites/${encodeURIComponent(id)}`, { method: "DELETE" }));
  }

  function openFavorite(favorite: FileManagerFavorite) {
    const nextRootIndex = roots.indexOf(favorite.root_path);
    if (nextRootIndex < 0) return;
    if (nextRootIndex !== rootIndex) setRootIndex(nextRootIndex);
    if (nextRootIndex !== rootIndex || favorite.path !== folder) openDirectory(favorite.path);
    setPickerOpen(false);
  }

  return <section className="document-viewer">
    <div className="document-folder-bar">
      <div className="document-folder-control">
        <span>文档文件夹</span>
        <select value={rootIndex} onChange={event => chooseRoot(Number(event.target.value))} disabled={!roots.length} aria-label="选择开放目录">
          {roots.map((root, index) => <option key={root} value={index}>{resolvedRoots[index] || root}</option>)}
        </select>
      </div>
      <button className="document-folder-path" type="button" onClick={openPicker} disabled={!roots.length} title="选择文件夹">
        <span>{folderLabel || "尚未配置开放目录"}</span><b>选择文件夹</b>
      </button>
      <Button variant="secondary" size="sm" type="button" onClick={openPicker} disabled={!roots.length}>浏览</Button>
    </div>

    <section className="document-favorites" aria-label="收藏文档路径">
      <div className="document-favorites-head">
        <div><strong>收藏路径</strong><span>{favorites.length ? "点击收藏项可直接打开对应目录" : "收藏常用项目路径后可快速切换"}</span></div>
        <Button variant="secondary" size="sm" type="button" onClick={addCurrentFavorite} disabled={!roots.length || Boolean(currentFavorite) || favoriteBusy}>{currentFavorite ? "已收藏当前路径" : "收藏当前路径"}</Button>
      </div>
      {favoriteError ? <ErrorState message={favoriteError} /> : null}
      {favorites.length ? <div className="document-favorite-list">
        {favorites.map(favorite => {
          const favoriteRootIndex = roots.indexOf(favorite.root_path);
          return <div className={`document-favorite${favorite.id === currentFavorite?.id ? " is-selected" : ""}`} key={favorite.id}>
            <button className="document-favorite-main" type="button" onClick={() => openFavorite(favorite)} disabled={favoriteRootIndex < 0} title={`${favorite.root_path}/${favorite.path}`}>
              <strong>{favorite.name}</strong>
              <small>{favorite.root_path}/{favorite.path}</small>
            </button>
            <Button variant="quiet" size="sm" type="button" onClick={() => removeFavorite(favorite.id)} disabled={favoriteBusy}>移除</Button>
          </div>;
        })}
      </div> : <p className="document-favorites-empty">还没有收藏路径。浏览到常用项目目录后，点击右上角“收藏当前路径”。</p>}
    </section>

    {pickerOpen ? <section className="document-folder-picker" aria-label="选择文档文件夹">
      <div className="document-picker-head"><div><strong>选择文档文件夹</strong><span>左侧会以文件夹层级展示当前目录中的 Markdown 文档。</span></div><Button variant="quiet" size="sm" type="button" onClick={() => setPickerOpen(false)}>关闭</Button></div>
      <div className="document-picker-breadcrumb"><button type="button" onClick={() => changePickerPath("")}>{resolvedRoots[rootIndex] || roots[rootIndex]}</button>{pickerPath.split("/").filter(Boolean).map((segment, index, segments) => <span key={`${index}-${segment}`}><b>/</b><button type="button" onClick={() => changePickerPath(segments.slice(0, index + 1).join("/"))}>{segment}</button></span>)}</div>
      <div className="document-picker-list">
        {pickerPath ? <button type="button" className="document-picker-row" onClick={() => changePickerPath(pickerPath.split("/").slice(0, -1).join("/"))}><span>↑</span>上一级</button> : null}
        {loadingPicker ? <LoadingState label="正在读取文件夹…" /> : pickerFolders.length ? pickerFolders.map(item => <button type="button" className="document-picker-row" key={item.path} onClick={() => changePickerPath(item.path)}><span>□</span>{item.name}</button>) : <EmptyState title="没有下级文件夹" detail="可以直接使用当前文件夹。" />}
      </div>
      <div className="document-picker-actions"><span>{`${resolvedRoots[rootIndex] || roots[rootIndex]}${pickerPath ? `/${pickerPath}` : ""}`}</span><Button size="sm" type="button" onClick={applyFolder}>使用此文件夹</Button></div>
    </section> : null}

    {error ? <ErrorState message={error} /> : null}
    <div className="document-workspace">
      <aside className="document-index">
        <div className="document-index-head"><div><strong>文档目录</strong><span>{loadingFiles ? "正在读取…" : `${visibleEntries.filter(isMarkdownFile).length} 篇`}</span></div><div className="document-index-breadcrumb"><button type="button" onClick={() => openDirectory("")}>{resolvedRoots[rootIndex] || roots[rootIndex]}</button>{folder.split("/").filter(Boolean).map((segment, index, segments) => <span key={`${index}-${segment}`}><b>/</b><button type="button" onClick={() => openDirectory(segments.slice(0, index + 1).join("/"))}>{segment}</button></span>)}</div><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选当前目录" aria-label="筛选当前目录" /></div>
        <div className="document-file-list">
          {loadingFiles ? <LoadingState label="正在读取当前文件夹…" /> : folder ? <button type="button" className="document-file document-folder-entry" onClick={() => openDirectory(folder.split("/").slice(0, -1).join("/"))}><strong>↑ 上一级</strong><span>返回父文件夹</span></button> : null}
          {!loadingFiles && visibleEntries.length ? visibleEntries.map(entry => entry.type === "directory" ? <button className="document-file document-folder-entry" type="button" key={entry.path} onClick={() => openDirectory(entry.path)} title={entry.path}><strong>□ {entry.name}</strong><span>{entry.symlink ? "软链接文件夹" : "文件夹"}</span></button> : <button className={`document-file${entry.path === selectedPath ? " is-selected" : ""}`} type="button" key={entry.path} onClick={() => selectDocument(entry.path)} title={entry.path}><strong>{entry.name.replace(/\.(md|markdown|mdown|mkdn)$/i, "")}</strong><span>{formatDate(entry.modified)}</span></button>) : null}
          {!loadingFiles && !visibleEntries.length ? <EmptyState title={directory?.entries.length ? "没有匹配的文档" : "这个文件夹没有 Markdown 文档"} detail={directory?.entries.length ? "可调整上方筛选条件。" : "点击顶部“选择文件夹”切换到包含 .md 文件的位置。"} /> : null}
        </div>
      </aside>
      <main className="document-reader">
        {loadingDocument ? <LoadingState label="正在打开文档…" /> : markdownDocument ? <><header className="document-reader-head"><div><span>{markdownDocument.path}</span><h1>{markdownDocument.name.replace(/\.(md|markdown|mdown|mkdn)$/i, "")}</h1></div><small>{formatBytes(markdownDocument.size)} · {formatDate(markdownDocument.modified)}</small></header><MarkdownContent content={markdownDocument.content} rootIndex={rootIndex} sourcePath={markdownDocument.path} onOpenMarkdown={openMarkdown} /></> : <EmptyState title="选择一篇文档开始阅读" detail="文档会在这里以阅读排版显示，代码块、列表、表格和相对图片均会保留。" />}
      </main>
    </div>
  </section>;
}
