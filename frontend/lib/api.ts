import type { ApiErrorShape } from "./types";

export const API_PATHS = {
  hub: "/api",
  pointClouds: "/api/point-clouds",
  llama: "/llama-manager/api",
  server: "/server/api",
  prompts: "/prompt/api",
} as const;

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.dispatchEvent(new CustomEvent("hannishub:unauthorized", { detail: next }));
}

export class ApiError extends Error {
  status: number;
  payload: ApiErrorShape;

  constructor(status: number, payload: ApiErrorShape) {
    super(payload.detail || payload.error || payload.message || `请求失败（${status}）`);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const payload = await response.json().catch(() => ({} as ApiErrorShape));
  if (response.status === 401) {
    redirectToLogin();
  }
  if (!response.ok) throw new ApiError(response.status, payload as ApiErrorShape);
  return payload as T;
}

export function jsonBody(value: unknown): BodyInit {
  return JSON.stringify(value);
}

export function encodePath(value: string): string {
  return encodeURIComponent(value);
}

export function uploadFile(
  path: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<ApiErrorShape> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("x-audio-filename", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", event => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      let payload: ApiErrorShape = {};
      try {
        payload = JSON.parse(request.responseText || "{}") as ApiErrorShape;
      } catch {
        payload = { detail: "服务未返回 JSON 响应" };
      }
      if (request.status === 401) redirectToLogin();
      if (request.status < 200 || request.status >= 300) {
        reject(new ApiError(request.status, payload));
        return;
      }
      resolve(payload);
    });
    request.addEventListener("error", () => reject(new Error("网络请求失败")));
    request.addEventListener("abort", () => reject(new Error("上传已取消")));
    request.send(file);
  });
}
