/** 文件游览的目录记录与浏览器拖拽文件夹读取。 */
export const BROWSER_LOCATION_KEY = "hannishub_file_browser_location";

export interface FileUploadItem {
  file: File;
  relativePath: string;
}

const UPLOAD_IGNORED_DIRECTORY_NAMES = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".cache", ".venv", "venv"]);

function validRelativePath(value: string): boolean {
  return value.length <= 4096 && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== "..");
}

export function readBrowserLocation(storage: Pick<Storage, "getItem">, resolvedRoots: string[]): { rootIndex: number; path: string } | null {
  try {
    const saved = JSON.parse(storage.getItem(BROWSER_LOCATION_KEY) || "null");
    if (!saved || typeof saved.root !== "string" || typeof saved.path !== "string") return null;
    const rootIndex = resolvedRoots.indexOf(saved.root);
    if (rootIndex < 0 || (saved.path && !validRelativePath(saved.path))) return null;
    return { rootIndex, path: saved.path };
  } catch {
    return null;
  }
}

export function uploadableRelativePath(value: string): boolean {
  return validRelativePath(value) && value.split("/").every(part => !UPLOAD_IGNORED_DIRECTORY_NAMES.has(part));
}

export function fileUploadItems(files: FileList | null): FileUploadItem[] {
  return Array.from(files || []).map(file => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, error => reject(new Error(`无法读取 ${entry.name}：${error.message}`))));
}

export async function collectUploadEntry(entry: FileSystemEntry, prefix = ""): Promise<FileUploadItem[]> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (!uploadableRelativePath(relativePath)) return [];
  if (entry.isFile) return [{ file: await readEntryFile(entry as FileSystemFileEntry), relativePath }];
  if (!entry.isDirectory) return [];
  // 同一个读取器会逐批返回目录条目，重新创建会从第一批开始，导致无限读取。
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const files: FileUploadItem[] = [];
  while (true) {
    const batch = await readDirectoryEntries(reader);
    if (!batch.length) break;
    for (const child of batch) files.push(...await collectUploadEntry(child, relativePath));
  }
  return files;
}

export async function collectDataTransferFiles(dataTransfer: DataTransfer): Promise<FileUploadItem[]> {
  // drop 事件结束后拖拽数据可能不可读，必须在第一次 await 前捕获条目和文件。
  const entries = Array.from(dataTransfer.items)
    .map(item => item.webkitGetAsEntry?.() || null)
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  const fallbackFiles = fileUploadItems(dataTransfer.files);
  if (!entries.length) return fallbackFiles;
  const files: FileUploadItem[] = [];
  for (const entry of entries) files.push(...await collectUploadEntry(entry));
  return files;
}
