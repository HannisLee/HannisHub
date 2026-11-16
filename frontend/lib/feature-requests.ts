import { apiFetch, jsonBody } from "./api";

const BASE = "/api/feature-requests";

/** 建议状态：待处理 / 已采纳 / 已完成 / 暂不考虑，只有管理员可以修改 */
export const FEATURE_STATUSES = ["open", "accepted", "done", "declined"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export const FEATURE_TEXT_MAX = 1000;

export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  open: "待处理", accepted: "已采纳", done: "已完成", declined: "暂不考虑",
};

export interface FeatureRequest {
  id: string;
  /** 提出时的大厅名字，不暴露登录用户名 */
  name: string;
  text: string;
  status: FeatureStatus;
  mine: boolean;
  created_at: number;
  updated_at: number;
}

export interface FeatureRequestsState {
  items: FeatureRequest[];
  can_moderate: boolean;
}

export function fetchFeatureRequests(): Promise<FeatureRequestsState> {
  return apiFetch<FeatureRequestsState>(BASE);
}

export function postFeatureRequest(text: string): Promise<FeatureRequest> {
  return apiFetch<FeatureRequest>(BASE, { method: "POST", body: jsonBody({ text }) });
}

export function setFeatureStatus(id: string, status: FeatureStatus): Promise<FeatureRequest> {
  return apiFetch<FeatureRequest>(`${BASE}/${encodeURIComponent(id)}`, { method: "PATCH", body: jsonBody({ status }) });
}

export function deleteFeatureRequest(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}
