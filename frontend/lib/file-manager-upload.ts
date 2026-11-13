import { API_PATHS, ApiError, apiFetch, jsonBody, uploadBinary } from "./api";
import type { FileManagerUploadResponse } from "./types";

/** 单片大小：远小于 Cloudflare 等反向代理约 100 MB 的请求体上限。 */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** 单个文件同时上传的分片数。 */
export const UPLOAD_CHUNK_CONCURRENCY = 4;
const CHUNK_RETRIES = 3;
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;

interface UploadInitResponse {
  upload_id: string;
  chunk_size: number;
  total_chunks: number;
}

interface ChunkedUploadOptions {
  rootIndex: number;
  directory: string;
  relativePath: string;
  file: File;
  overwrite: boolean;
  /** 已确认写入及正在传输的字节数之和 */
  onProgress: (loadedBytes: number) => void;
}

/** 网络错误、超时、代理 5xx 与限流可以重试；参数或冲突类 4xx 直接失败。 */
function retryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return !(error instanceof Error && error.message === "上传已取消");
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

/** 分片并发上传单个文件：创建会话 → 并发写入各分片（失败自动重试）→ 服务端合并。 */
export async function uploadFileInChunks({ rootIndex, directory, relativePath, file, overwrite, onProgress }: ChunkedUploadOptions): Promise<FileManagerUploadResponse> {
  const params = new URLSearchParams({ root: String(rootIndex), path: directory });
  const session = await apiFetch<UploadInitResponse>(`${API_PATHS.fileManager}/uploads?${params}`, {
    method: "POST",
    body: jsonBody({ file_path: relativePath, size: file.size, chunk_size: UPLOAD_CHUNK_BYTES, overwrite }),
  });
  const base = `${API_PATHS.fileManager}/uploads/${encodeURIComponent(session.upload_id)}`;
  const inflight = new Map<number, number>();
  let confirmedBytes = 0;
  const report = () => onProgress(confirmedBytes + [...inflight.values()].reduce((sum, value) => sum + value, 0));

  async function sendChunk(index: number) {
    const start = index * session.chunk_size;
    const blob = file.slice(start, Math.min(file.size, start + session.chunk_size));
    for (let attempt = 1; ; attempt += 1) {
      try {
        await uploadBinary(`${base}/chunks/${index}`, blob, { "Content-Type": "application/octet-stream" }, percent => {
          inflight.set(index, blob.size * percent / 100);
          report();
        }, CHUNK_TIMEOUT_MS, "PUT");
        inflight.delete(index);
        confirmedBytes += blob.size;
        report();
        return;
      } catch (error) {
        inflight.delete(index);
        report();
        if (attempt >= CHUNK_RETRIES || !retryable(error)) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`第 ${index + 1}/${session.total_chunks} 片上传失败（已尝试 ${attempt} 次）：${reason}`);
        }
        await wait(1000 * attempt);
      }
    }
  }

  try {
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < session.total_chunks) {
        const index = next++;
        try {
          await sendChunk(index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(UPLOAD_CHUNK_CONCURRENCY, session.total_chunks) }, worker));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
    return await apiFetch<FileManagerUploadResponse>(`${base}/complete`, { method: "POST" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // 尽力通知服务端清理临时文件并记录失败原因，清理失败不覆盖原始错误。
    void apiFetch(`${base}?${new URLSearchParams({ reason: reason.slice(0, 200) })}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}
