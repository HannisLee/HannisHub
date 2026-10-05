// 录音分片持续写入浏览器，服务端确认归档后仍保留本地音频。
export interface LocalRecording {
  id: string;
  created_at: string;
  mime_type: string;
  size: number;
  chunks: number;
  ready: boolean;
  uploaded: boolean;
  applied: boolean;
  interrupted?: boolean;
  insert_mode?: VoiceInsertMode;
}

export type VoiceInsertMode = "replace" | "append";

export interface ServerRecording {
  id: string;
  created_at: string;
  mime_type: string;
  size: number;
  status: "queued" | "processing" | "waiting_config" | "failed" | "done";
  text: string;
  error: string;
  archive_dir: string;
}

export interface ExternalAsrSettings {
  api_url: string;
  api_key: string;
  model: string;
  language: string;
  archive_dir: string;
  timeout_seconds: number;
  ffmpeg_available?: boolean;
  resolved_api_url?: string;
  resolved_archive_dir?: string;
}

function openAudioStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("hannishub_prompt_audio", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("recordings", { keyPath: "id" });
      request.result.createObjectStore("chunks", { keyPath: ["id", "index"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error("无法打开本地录音存储"));
    request.onblocked = () => reject(Error("本地存储被其他标签页阻塞，请关闭其他提示词页面"));
  });
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, action: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openAudioStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = () => { db.close(); reject(tx.error || Error("本地录音保存失败，可能存储空间不足")); };
    tx.onerror = () => { /* 由 onabort 统一报告，避免尚未提交就显示成功。 */ };
    action(tx, result => { value = result; });
  });
}

export function createLocalRecording(item: LocalRecording): Promise<void> {
  return transaction(["recordings"], "readwrite", tx => { tx.objectStore("recordings").add(item); });
}

export function patchLocalRecording(id: string, changes: Partial<LocalRecording>): Promise<void> {
  return transaction(["recordings"], "readwrite", tx => {
    const store = tx.objectStore("recordings");
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) { tx.abort(); return; }
      store.put({ ...request.result, ...changes });
    };
  });
}

export function appendAudioChunk(id: string, chunk: Blob): Promise<void> {
  return transaction(["recordings", "chunks"], "readwrite", tx => {
    const store = tx.objectStore("recordings");
    const request = store.get(id);
    request.onsuccess = () => {
      const item = request.result as LocalRecording | undefined;
      if (!item) { tx.abort(); return; }
      tx.objectStore("chunks").add({ id, index: item.chunks, blob: chunk });
      store.put({ ...item, chunks: item.chunks + 1, size: item.size + chunk.size });
    };
  });
}

export function listLocalRecordings(): Promise<LocalRecording[]> {
  return transaction(["recordings"], "readonly", (tx, result) => {
    const request = tx.objectStore("recordings").getAll();
    request.onsuccess = () => result(request.result as LocalRecording[]);
  });
}

export function deleteLocalRecording(id: string): Promise<void> {
  return transaction(["recordings", "chunks"], "readwrite", tx => {
    tx.objectStore("recordings").delete(id);
    tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  });
}

export function readLocalAudio(item: Pick<LocalRecording, "id" | "mime_type">): Promise<Blob> {
  return transaction(["chunks"], "readonly", (tx, result) => {
    const request = tx.objectStore("chunks").getAll(IDBKeyRange.bound([item.id, 0], [item.id, Number.MAX_SAFE_INTEGER]));
    request.onsuccess = () => result(new Blob(request.result.map(chunk => chunk.blob), { type: item.mime_type }));
  });
}

export function audioExtension(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

export function downloadAudio(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
