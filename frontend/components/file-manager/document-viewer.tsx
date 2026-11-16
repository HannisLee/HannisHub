"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import { copyToClipboard } from "../../lib/clipboard";
import type {
  FileConnection,
  FileManagerDirectoryResponse,
  FileManagerEntry,
  MarkdownDocument,
} from "../../lib/types";
import { Button, EmptyState, ErrorState, LoadingState } from "../ui/primitives";
import { FileConnectionBar } from "./file-connection-bar";

type MarkdownLinkHandler = (path: string) => void;

const DEFAULT_DOCUMENT_FOLDER = "/home/lihan/reproduce/RadioGS-stage1";
const DOCUMENT_LOCATION_KEY = "hannishub_document_viewer_location";
const REMOTE_LOCATION_KEY = "hannishub_document_viewer_remote_locations";
const ACTIVE_CONN_KEY = "hannishub_doc_active_connection";
const INDEX_WIDTH_KEY = "hannishub_document_index_width";
const INDEX_COLLAPSED_KEY = "hannishub_document_index_collapsed";
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "avif", "apng", "bmp", "ico", "svg", "tif", "tiff", "heic", "heif", "jxl"]);
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

interface RemoteDocumentLocation { folder: string; document: string }

function readRemoteLocations(): Record<string, RemoteDocumentLocation> {
  try {
    const value = JSON.parse(window.localStorage.getItem(REMOTE_LOCATION_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readRemoteLocation(connectionId: string): RemoteDocumentLocation {
  const value = readRemoteLocations()[connectionId];
  if (!value || typeof value.folder !== "string" || typeof value.document !== "string" ||
      (value.document && (value.document.split("/").slice(0, -1).join("/") || (value.document.startsWith("/") ? "/" : "")) !== value.folder)) {
    return { folder: "", document: "" };
  }
  return value;
}

function fileKind(path: string): "markdown" | "image" | "pdf" | "other" {
  const name = path.split("/").pop() || "";
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() || "" : "";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "pdf") return "pdf";
  return "other";
}

/** 主目录内使用 ~，其他位置保留绝对路径。 */
function displayHomePath(path: string, home: string): string {
  if (!home) return path;
  const normalizedHome = home.replace(/\/+$/, "") || "/";
  if (path === normalizedHome) return "~";
  if (normalizedHome !== "/" && path.startsWith(`${normalizedHome}/`)) return `~${path.slice(normalizedHome.length)}`;
  if (normalizedHome === "/" && path.startsWith("/")) return `~${path}`;
  return path;
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

function resourceUrl(rootIndex: number, path: string, connectionId?: string): string {
  if (connectionId && connectionId !== "local") {
    return `${API_PATHS.fileManager}/remote/${encodeURIComponent(connectionId)}/resource?${new URLSearchParams({ path })}`;
  }
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
  connectionId?: string,
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
      result.push(
        imagePath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="markdown-image"
            key={key}
            src={resourceUrl(rootIndex, imagePath, connectionId)}
            alt={image[1]}
            loading="lazy"
          />
        ) : (
          <span className="markdown-missing-image" key={key}>
            图片：{image[1] || image[2]}
          </span>
        )
      );
    } else if (link) {
      const localPath = normalizeLocalReference(link[2], sourcePath);
      if (localPath?.match(/\.(md|markdown|mdown|mkdn)$/i)) {
        result.push(
          <button className="markdown-link-button" type="button" key={key} onClick={() => onOpenMarkdown(localPath)}>
            {link[1]}
          </button>
        );
      } else if (localPath) {
        result.push(
          <a className="markdown-link" key={key} href={resourceUrl(rootIndex, localPath, connectionId)} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      } else {
        const href = link[2].replace(/^<|>$/g, "");
        result.push(
          <a
            className="markdown-link"
            key={key}
            href={href}
            target={href.startsWith("#") ? undefined : "_blank"}
            rel={href.startsWith("#") ? undefined : "noreferrer"}
          >
            {link[1]}
          </a>
        );
      }
    } else if (token.startsWith("`")) {
      result.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      result.push(<strong key={key}>{inlineMarkdown(token.slice(2, -2), rootIndex, sourcePath, onOpenMarkdown, `${key}-strong`, connectionId)}</strong>);
    } else {
      result.push(<em key={key}>{inlineMarkdown(token.slice(1, -1), rootIndex, sourcePath, onOpenMarkdown, `${key}-em`, connectionId)}</em>);
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

function MarkdownContent({
  content,
  rootIndex,
  sourcePath,
  onOpenMarkdown,
  connectionId,
}: {
  content: string;
  rootIndex: number;
  sourcePath: string;
  onOpenMarkdown: MarkdownLinkHandler;
  connectionId?: string;
}) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  if (lines[0]?.trim() === "---") {
    const ending = lines.slice(1).findIndex(line => line.trim() === "---");
    if (ending >= 0) index = ending + 2;
  }
  const inline = (text: string, key: string) => inlineMarkdown(text, rootIndex, sourcePath, onOpenMarkdown, key, connectionId);

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

function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);

  function changeZoom(delta: number) {
    setZoom(value => Math.min(8, Math.max(0.25, Math.round((value + delta) * 100) / 100)));
  }

  return (
    <dialog ref={dialogRef} className="document-image-lightbox" aria-label={`${name} 图片查看`} onClose={onClose}>
      <div className="document-image-lightbox-bar">
        <strong title={name}>{name}</strong>
        <div className="document-image-lightbox-actions">
          <Button variant="secondary" size="sm" type="button" onClick={() => changeZoom(-0.25)} aria-label="缩小图片">−</Button>
          <Button variant="secondary" size="sm" type="button" onClick={() => setZoom(1)} aria-label="重置图片缩放">{Math.round(zoom * 100)}%</Button>
          <Button variant="secondary" size="sm" type="button" onClick={() => changeZoom(0.25)} aria-label="放大图片">＋</Button>
          <Button variant="secondary" size="sm" type="button" onClick={onClose}>关闭</Button>
        </div>
      </div>
      <div className="document-image-lightbox-viewport">
        {/* 使用图片元素隔离 SVG，缩放后允许滚动查看细节。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={name} style={fitWidth ? { width: `${fitWidth * zoom}px` } : undefined} onLoad={event => {
          const image = event.currentTarget;
          const viewport = image.parentElement;
          if (!viewport || !image.naturalWidth || !image.naturalHeight) return;
          const scale = Math.min(1, (viewport.clientWidth - 32) / image.naturalWidth, (viewport.clientHeight - 32) / image.naturalHeight);
          setFitWidth(Math.max(1, image.naturalWidth * scale));
        }} />
      </div>
    </dialog>
  );
}

export function DocumentViewer() {
  // 连接与常用目录
  const [connections, setConnections] = useState<FileConnection[]>([
    { id: "local", name: "本机", type: "local" },
  ]);
  const [activeConnectionId, setActiveConnectionId] = useState<string>("local");
  const [commonDirectories, setCommonDirectories] = useState<string[]>([]);

  const [roots, setRoots] = useState<string[]>([]);
  const [resolvedRoots, setResolvedRoots] = useState<string[]>([]);
  const [rootIndex, setRootIndex] = useState(0);
  const [folder, setFolder] = useState("");
  const [directory, setDirectory] = useState<FileManagerDirectoryResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [markdownDocument, setMarkdownDocument] = useState<MarkdownDocument | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState(false);
  const [imageExpanded, setImageExpanded] = useState(false);
  const [indexWidth, setIndexWidth] = useState(300);
  const [indexCollapsed, setIndexCollapsed] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);


  const restoredDirectoryRef = useRef<FileManagerDirectoryResponse | null>(null);

  const isRemote = activeConnectionId !== "local";
  const activeConnection = connections.find(c => c.id === activeConnectionId);
  const selectedEntry = directory?.entries.find(entry => entry.type !== "directory" && entry.path === selectedPath);
  const selectedKind = fileKind(selectedPath);

  useEffect(() => {
    try {
      const width = Number(window.localStorage.getItem(INDEX_WIDTH_KEY));
      // 从浏览器存储恢复布局，服务端渲染时使用默认值。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (width >= 220 && width <= 700) setIndexWidth(width);
      setIndexCollapsed(window.localStorage.getItem(INDEX_COLLAPSED_KEY) === "true");
    } catch {
      // 浏览器禁用存储时使用默认布局。
    }
  }, []);

  function updateIndexWidth(width: number) {
    const available = workspaceRef.current?.clientWidth || 960;
    const next = Math.round(Math.max(220, Math.min(700, Math.max(220, available - 260), width)));
    setIndexWidth(next);
    try { window.localStorage.setItem(INDEX_WIDTH_KEY, String(next)); } catch { /* 忽略 */ }
  }

  function toggleIndex() {
    const next = !indexCollapsed;
    setIndexCollapsed(next);
    try { window.localStorage.setItem(INDEX_COLLAPSED_KEY, String(next)); } catch { /* 忽略 */ }
  }


  // 载入可用连接
  const loadConnections = useCallback(async () => {
    try {
      const data = await apiFetch<{ connections: FileConnection[] }>(`${API_PATHS.fileManager}/connections`);
      if (data.connections?.length) {
        setConnections(data.connections);
      }
    } catch {
      // 容错降级
    }
  }, []);

  // 载入常用目录
  const loadCommonDirectories = useCallback(async () => {
    try {
      const data = await apiFetch<{ directories: string[] }>(`${API_PATHS.fileManager}/common-directories`);
      if (Array.isArray(data.directories)) {
        setCommonDirectories(data.directories);
      }
    } catch {
      // 容错
    }
  }, []);

  // 保存常用目录
  const handleSaveCommonDirectories = useCallback(async (dirs: string[]) => {
    const res = await apiFetch<{ directories: string[] }>(`${API_PATHS.fileManager}/common-directories`, {
      method: "PUT",
      body: jsonBody({ directories: dirs }),
    });
    setCommonDirectories(res.directories || []);
  }, []);

  useEffect(() => {
    void loadConnections();
    void loadCommonDirectories();
  }, [loadConnections, loadCommonDirectories]);

  // 本机 settings 载入
  useEffect(() => {
    let active = true;
    apiFetch<{ roots: string[]; resolved_roots: string[]; home_dir: string }>(`${API_PATHS.fileManager}/settings`)
      .then(async value => {
        if (!active) return;
        setHomeDir(value.home_dir || "");
        const nextRoots = value.roots || [];
        const nextResolvedRoots = value.resolved_roots || nextRoots;
        let nextRootIndex = 0;
        let nextFolder = "";
        let nextDocumentPath = "";
        let nextDirectory: FileManagerDirectoryResponse | null = null;

        try {
          const savedConn = window.localStorage.getItem(ACTIVE_CONN_KEY);
          if (savedConn && savedConn !== "local") {
            setActiveConnectionId(savedConn);
            const saved = readRemoteLocation(savedConn);
            setFolder(saved.folder);
            setSelectedPath(saved.document);
            setLoadingDocument(Boolean(saved.document) && fileKind(saved.document) === "markdown");
            setRoots(nextRoots);
            setResolvedRoots(nextResolvedRoots);
            setInitialized(true);
            return;
          }
        } catch {
          // 忽略
        }

        let saved: SavedDocumentLocation | null = null;
        try {
          saved = readSavedDocumentLocation(window.localStorage, nextResolvedRoots);
        } catch {
          /* 忽略 */
        }
        if (saved) {
          try {
            const data = await apiFetch<FileManagerDirectoryResponse>(
              `${API_PATHS.fileManager}/directory?${new URLSearchParams({
                root: String(nextResolvedRoots.indexOf(saved.root)),
                path: saved.folder,
              })}`
            );
            if (!active) return;
            nextRootIndex = data.root_index;
            nextFolder = data.path;
            nextDirectory = data;
            nextDocumentPath = data.entries.some(entry => entry.path === saved?.document) ? saved.document : "";
          } catch {
            // 回退
          }
        }
        if (!nextDirectory) {
          const defaultRootIndex = nextResolvedRoots.findIndex(
            root => DEFAULT_DOCUMENT_FOLDER === root || DEFAULT_DOCUMENT_FOLDER.startsWith(`${root.replace(/\/+$/, "")}/`)
          );
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
        setLoadingDocument(Boolean(nextDocumentPath) && fileKind(nextDocumentPath) === "markdown");
        if (nextDirectory) {
          restoredDirectoryRef.current = nextDirectory;
          setDirectory(nextDirectory);
        }
        if (!nextRoots.length) setLoadingFiles(false);
        setInitialized(true);
      })
      .catch(value => {
        if (active) {
          setError(errorMessage(value));
          setLoadingFiles(false);
          setInitialized(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  // 读取目录条目（区分本机与远程 SSH）
  useEffect(() => {
    if (!initialized || (activeConnectionId === "local" && !roots.length)) return;
    if (activeConnectionId === "local" && restoredDirectoryRef.current) {
      const value = restoredDirectoryRef.current;
      restoredDirectoryRef.current = null;
      setDirectory(value);
      setSelectedPath(current => {
        const markdownFiles = value.entries.filter(isMarkdownFile);
        const nextPath = value.entries.some(entry => entry.type !== "directory" && entry.path === current) ? current : markdownFiles.sort(compareDocumentEntries)[0]?.path || "";
        if (nextPath !== current) {
          setMarkdownDocument(null);
          setLoadingDocument(Boolean(nextPath) && fileKind(nextPath) === "markdown");
        }
        return nextPath;
      });
      setError("");
      setLoadingFiles(false);
      return;
    }

    let active = true;
    setLoadingFiles(true);
    const directoryUrl =
      activeConnectionId !== "local"
        ? `${API_PATHS.fileManager}/remote/${encodeURIComponent(activeConnectionId)}/directory?path=${encodeURIComponent(folder)}`
        : `${API_PATHS.fileManager}/directory?${new URLSearchParams({ root: String(rootIndex), path: folder })}`;

    apiFetch<FileManagerDirectoryResponse>(directoryUrl)
      .then(value => {
        if (!active) return;
        setDirectory(value);
        setSelectedPath(current => {
          const markdownFiles = value.entries.filter(isMarkdownFile);
          const nextPath = value.entries.some(entry => entry.type !== "directory" && entry.path === current) ? current : markdownFiles.sort(compareDocumentEntries)[0]?.path || "";
          if (nextPath !== current) {
            setMarkdownDocument(null);
            setLoadingDocument(Boolean(nextPath) && fileKind(nextPath) === "markdown");
          }
          return nextPath;
        });
        setError("");
      })
      .catch(value => {
        if (active) setError(errorMessage(value));
      })
      .finally(() => {
        if (active) setLoadingFiles(false);
      });
    return () => {
      active = false;
    };
  }, [roots, rootIndex, folder, activeConnectionId, initialized]);

  // 读取 Markdown 内容（区分本机与远程 SSH）
  useEffect(() => {
    if (!initialized || !selectedPath) return;
    if (fileKind(selectedPath) !== "markdown") return;
    let active = true;
    const markdownUrl =
      activeConnectionId !== "local"
        ? `${API_PATHS.fileManager}/remote/${encodeURIComponent(activeConnectionId)}/markdown?path=${encodeURIComponent(selectedPath)}`
        : `${API_PATHS.fileManager}/markdown?${new URLSearchParams({ root: String(rootIndex), path: selectedPath })}`;

    apiFetch<MarkdownDocument>(markdownUrl)
      .then(value => {
        if (active) setMarkdownDocument(value);
      })
      .catch(value => {
        if (active) setError(errorMessage(value));
      })
      .finally(() => {
        if (active) setLoadingDocument(false);
      });
    return () => {
      active = false;
    };
  }, [rootIndex, selectedPath, activeConnectionId, initialized]);

  // 只保存成功读取的位置，避免加载失败覆盖上次记录。
  useEffect(() => {
    if (!initialized) return;
    try {
      window.localStorage.setItem(ACTIVE_CONN_KEY, activeConnectionId);
      if (!directory || loadingFiles || loadingDocument) return;
      const openedDocument = selectedEntry && (selectedKind !== "markdown" || markdownDocument?.path === selectedPath) ? selectedPath : "";
      if (activeConnectionId === "local") {
        if (directory.root_index !== rootIndex || directory.path !== folder) return;
        window.localStorage.setItem(DOCUMENT_LOCATION_KEY, JSON.stringify({ root: resolvedRoots[rootIndex], folder, document: openedDocument }));
      } else {
        const locations = readRemoteLocations();
        locations[activeConnectionId] = { folder: directory.path, document: openedDocument };
        window.localStorage.setItem(REMOTE_LOCATION_KEY, JSON.stringify(locations));
      }
    } catch {
      // 浏览器禁用存储时仍可正常浏览。
    }
  }, [initialized, resolvedRoots, rootIndex, folder, directory, markdownDocument, selectedPath, loadingFiles, loadingDocument, activeConnectionId, selectedEntry, selectedKind]);

  const visibleEntries = useMemo(() => {
    return [...(directory?.entries || [])].sort(compareDocumentEntries);
  }, [directory]);

  function handleSwitchConnection(connId: string) {
    if (connId === activeConnectionId) return;
    let nextFolder = "";
    let nextDocument = "";
    if (connId === "local") {
      let saved: SavedDocumentLocation | null = null;
      try { saved = readSavedDocumentLocation(window.localStorage, resolvedRoots); } catch { /* 浏览器禁用存储 */ }
      if (saved) {
        setRootIndex(resolvedRoots.indexOf(saved.root));
        nextFolder = saved.folder;
        nextDocument = saved.document;
      }
    } else {
      const saved = readRemoteLocation(connId);
      nextFolder = saved.folder;
      nextDocument = saved.document;
    }
    setLoadingFiles(true);
    setDirectory(null);
    setActiveConnectionId(connId);
    setFolder(nextFolder);
    setSelectedPath(nextDocument);
    setLoadingDocument(Boolean(nextDocument) && fileKind(nextDocument) === "markdown");
    setMarkdownDocument(null);
    setCopyStatus("");
    setPreviewError(false);
  }

  function chooseRoot(nextRoot: number) {
    if (nextRoot === rootIndex) return;
    setCopyStatus("");
    setPreviewError(false);
    setLoadingFiles(true);
    setDirectory(null);
    setRootIndex(nextRoot);
    setFolder("");
    setSelectedPath("");
    setMarkdownDocument(null);
  }

  function openMarkdown(path: string) {
    const parentPath = path.split("/").slice(0, -1).join("/");
    if (parentPath !== folder) openDirectory(parentPath, path);
    selectDocument(path);
    window.requestAnimationFrame(() => window.document.querySelector(".document-reader")?.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function openDirectory(path: string, documentPath = "") {
    if (path === folder && directory) {
      if (documentPath) selectDocument(documentPath);
      return;
    }
    setLoadingFiles(true);
    setDirectory(null);
    setFolder(path);
    setCopyStatus("");
    setPreviewError(false);
    setMarkdownDocument(null);
    setSelectedPath(documentPath);
    setLoadingDocument(Boolean(documentPath) && fileKind(documentPath) === "markdown");
  }

  function selectDocument(path: string) {
    if (path === selectedPath) return;
    setLoadingDocument(fileKind(path) === "markdown");
    setMarkdownDocument(null);
    setPreviewError(false);
    setError("");
    setSelectedPath(path);
  }

  return (
    <section className="document-viewer">
      {/* 顶部服务器连接与常用目录切换栏 */}
      <FileConnectionBar
        connections={connections}
        activeConnectionId={activeConnectionId}
        onSelectConnection={handleSwitchConnection}
        commonDirectories={commonDirectories}
        onSelectCommonDirectory={dir => openDirectory(dir)}
        onRefreshConnections={loadConnections}
        onSaveCommonDirectories={handleSaveCommonDirectories}
      />

      {error ? <ErrorState message={error} /> : null}
      <div className="document-index-head">
        <button type="button" className="document-index-toggle" onClick={toggleIndex} aria-label={indexCollapsed ? "展开文件列表" : "折叠文件列表"} title={indexCollapsed ? "展开文件列表" : "折叠文件列表"} aria-expanded={!indexCollapsed}>
          {indexCollapsed ? "›" : "‹"}
        </button>
        <nav className="document-index-breadcrumb" aria-label="当前目录路径">
          <button type="button" onClick={() => openDirectory("")}>
            {isRemote ? "~" : displayHomePath(resolvedRoots[rootIndex] || roots[rootIndex] || "", homeDir)}
          </button>
          {folder.split("/").filter(Boolean).map((segment, index, segments) => (
            <span key={`${index}-${segment}`}>
              <b>/</b>
              <button type="button" onClick={() => openDirectory(`${folder.startsWith("/") ? "/" : ""}${segments.slice(0, index + 1).join("/")}`)}>{segment}</button>
            </span>
          ))}
        </nav>
        {!isRemote && roots.length > 1 ? (
          <select value={rootIndex} onChange={event => chooseRoot(Number(event.target.value))} aria-label="选择开放目录">
            {roots.map((root, index) => <option key={root} value={index}>{resolvedRoots[index] || root}</option>)}
          </select>
        ) : null}
        <Button variant="secondary" size="sm" type="button" disabled={!directory} onClick={async () => {
          const path = isRemote
            ? directory?.path.startsWith("/") ? displayHomePath(directory.path, directory.root_path) : `~${directory?.path ? `/${directory.path}` : ""}`
            : displayHomePath(`${(resolvedRoots[rootIndex] || "").replace(/\/$/, "")}${folder ? `/${folder}` : ""}` || "/", homeDir);
          setCopyStatus(path && await copyToClipboard(path) ? "已复制" : "复制失败");
        }}>{copyStatus || "复制路径"}</Button>
      </div>

      <div ref={workspaceRef} className={`document-workspace${indexCollapsed ? " is-index-collapsed" : ""}`} style={{ "--document-index-width": `${indexWidth}px` } as CSSProperties}>
        <aside className="document-index">
          {!indexCollapsed ? <>
          <div className="document-file-list">
            {loadingFiles ? (
              <LoadingState label="正在读取当前文件夹…" />
            ) : folder ? (
              <button type="button" className="document-file document-folder-entry" onClick={() => openDirectory(folder.split("/").slice(0, -1).join("/"))}>
                <strong>↑ 上一级</strong>
                <span>返回父文件夹</span>
              </button>
            ) : null}
            {!loadingFiles && visibleEntries.length
              ? visibleEntries.map(entry =>
                  entry.type === "directory" ? (
                    <button className="document-file document-folder-entry" type="button" key={entry.path} onClick={() => openDirectory(entry.path)} title={entry.path}>
                      <strong>□ {entry.name}</strong>
                      <span>{entry.symlink ? "软链接文件夹" : "文件夹"}</span>
                    </button>
                  ) : (
                    <button
                      className={`document-file${entry.path === selectedPath ? " is-selected" : ""}`}
                      type="button"
                      key={entry.path}
                      onClick={() => selectDocument(entry.path)}
                      title={entry.path}
                    >
                      <strong>{entry.name}</strong>
                      <span>{formatDate(entry.modified)}</span>
                    </button>
                  )
                )
              : null}
            {!loadingFiles && !visibleEntries.length ? (
              <EmptyState
                title="这个文件夹为空"
                detail="可通过上级目录或常用目录切换位置。"
              />
            ) : null}
          </div>
          <div className="document-index-resizer" role="separator" aria-label="调整文件列表宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={700} aria-valuenow={indexWidth} tabIndex={0}
            onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && workspaceRef.current) updateIndexWidth(event.clientX - workspaceRef.current.getBoundingClientRect().left); }}
            onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); updateIndexWidth(indexWidth + (event.key === "ArrowRight" ? 16 : -16)); } }} />
          </> : null}
        </aside>
        <main className="document-reader">
          {loadingDocument ? (
            <LoadingState label="正在打开文档…" />
          ) : selectedEntry && selectedKind !== "markdown" ? (
            <>
              <header className="document-reader-head">
                <h1 title={selectedEntry.name}>{selectedEntry.name}</h1>
                <small>{formatBytes(selectedEntry.size)} · {formatDate(selectedEntry.modified)}</small>
              </header>
              {selectedKind === "image" ? (
                previewError ? <EmptyState title="无法显示图片" detail="文件可能已损坏，或浏览器不支持此图片格式。" /> :
                // 图片地址来自受限资源接口，SVG 作为图片加载。
                <div className="document-image-preview-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="document-image-preview" src={resourceUrl(rootIndex, selectedPath, activeConnectionId)} alt={selectedEntry.name} onError={() => setPreviewError(true)} />
                  <Button variant="secondary" size="sm" type="button" onClick={() => setImageExpanded(true)}>全屏查看</Button>
                </div>
              ) : selectedKind === "pdf" ? (
                <iframe className="document-pdf-preview" title={`${selectedEntry.name} 预览`} src={resourceUrl(rootIndex, selectedPath, activeConnectionId)} />
              ) : <EmptyState title="暂不支持预览此文件" detail="目前支持 Markdown、图片、SVG 和 PDF。" />}
            </>
          ) : markdownDocument && markdownDocument.path === selectedPath ? (
            <>
              <header className="document-reader-head">
                <h1 title={markdownDocument.name}>{markdownDocument.name.replace(/\.(md|markdown|mdown|mkdn)$/i, "")}</h1>
                <small>
                  {formatBytes(markdownDocument.size)} · {formatDate(markdownDocument.modified)}
                </small>
              </header>
              <MarkdownContent
                content={markdownDocument.content}
                rootIndex={rootIndex}
                sourcePath={markdownDocument.path}
                onOpenMarkdown={openMarkdown}
                connectionId={isRemote ? activeConnectionId : "local"}
              />
            </>
          ) : (
            <EmptyState
              title="选择文件开始查看"
              detail="支持查看 Markdown、图片、SVG 和 PDF。"
            />
          )}
        </main>
      </div>
      {imageExpanded && selectedEntry && selectedKind === "image" ? (
        <ImageLightbox src={resourceUrl(rootIndex, selectedPath, activeConnectionId)} name={selectedEntry.name} onClose={() => setImageExpanded(false)} />
      ) : null}
    </section>
  );
}
