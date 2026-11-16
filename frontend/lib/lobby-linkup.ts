import { API_PATHS, apiFetch, jsonBody } from "./api";

/** 大厅街机连连看：排行榜接口与「关闭前确认」状态 */

const BASE = `${API_PATHS.chatLobby}/linkup`;

export type RankedMode = "campaign" | "daily";

export interface LinkupRankRow {
  /** 提交时的大厅名字，不暴露登录用户名 */
  name: string;
  score: number;
  level: number;
  cleared: boolean;
  plays: number;
  mine: boolean;
}

export interface LinkupMine {
  score: number;
  level: number;
  cleared: boolean;
  plays: number;
  rank: number;
}

export interface LinkupBoard {
  /** 服务器今天的日期（YYYY-MM-DD），每日挑战用它生成盘面 */
  day: string;
  campaign: LinkupRankRow[];
  daily: LinkupRankRow[];
  mine: { campaign: LinkupMine | null; daily: LinkupMine | null };
}

export interface LinkupSubmitResult {
  record: boolean;
  previous: number | null;
  rank: number | null;
  board: LinkupBoard;
}

export interface LinkupScore {
  mode: RankedMode;
  score: number;
  level: number;
  cleared: boolean;
  day?: string;
}

export function fetchLinkupBoard(): Promise<LinkupBoard> {
  return apiFetch<LinkupBoard>(BASE);
}

export function submitLinkupScore(score: LinkupScore): Promise<LinkupSubmitResult> {
  return apiFetch<LinkupSubmitResult>(`${BASE}/scores`, { method: "POST", body: jsonBody(score) });
}

/** 关闭面板时仍在进行中的计分局：卸载时用 keepalive 提交，页面关闭也能送达 */
export function submitLinkupOnExit(score: LinkupScore): void {
  try {
    void fetch(`${BASE}/scores`, {
      method: "POST", credentials: "include", keepalive: true,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(score),
    }).catch(() => undefined);
  } catch {
    // 页面正在关闭时忽略
  }
}

let activeRun: (() => string | null) | null = null;

/** 面板挂载时登记：返回提示文字表示关闭前需要确认 */
export function setLinkupCloseGuard(guard: (() => string | null) | null): void {
  activeRun = guard;
}

export function linkupCloseWarning(): string | null {
  return activeRun?.() ?? null;
}
