/** 聊天大厅台球桌（中式八球）：消息类型与同步通道。
 *  台球消息复用大厅同步 WebSocket（/api/chat-lobby/ws），协议见 chatworld/lobby_pool.py。
 *  连接由大厅场景的 PresenceClient 持有：它把发送函数绑定到这里，并把收到的台球消息转发给订阅者。 */

export type PoolSeat = "left" | "right";
export type PoolGroup = "solid" | "stripe";
export type PoolPhase = "break" | "play" | "over";

/** 对局状态：击球方浏览器在每一杆后计算并上传，服务端校验后保存转发 */
export interface PoolGame {
  /** 三角框内 15 个位置的球号（第 0 个为顶点，第 4 个为黑 8） */
  rack: number[];
  /** 台面上的球 [球号, x, y]（毫米，0 号为白球）；null 表示尚未开球，按 rack 摆放 */
  balls: [number, number, number][] | null;
  turn: PoolSeat;
  breaker: PoolSeat;
  phase: PoolPhase;
  groups: Record<PoolSeat, PoolGroup | null>;
  /** 自由球：当前击球方可以拖动白球摆放 */
  hand: boolean;
  /** 自由球只能摆在开球区（开球线左侧） */
  kitchen: boolean;
  winner: PoolSeat | null;
  msg: string;
  shots: number;
  last: { pocketed: number[]; foul: string | null } | null;
}

/** 一杆的击球参数：白球初速度、上下旋（滚动速度向量）、侧旋，以及击球时白球位置；单位毫米、毫米/秒 */
export interface PoolShot {
  vx: number;
  vy: number;
  sx: number;
  sy: number;
  w: number;
  cx: number;
  cy: number;
}

export type PoolStatus = "open" | "playing" | "over";

export interface PoolTableView {
  seats: Record<PoolSeat, { name: string } | null>;
  status: PoolStatus;
  solo: boolean;
  game: PoolGame | null;
  version: number;
  /** 自己（当前账号）占的球位 */
  you: PoolSeat[];
  rematch: PoolSeat[];
}

export interface PoolSummary {
  left: string | null;
  right: string | null;
  status: PoolStatus;
  solo: boolean;
}

export type PoolServerMessage =
  | { type: "pool"; ev: "table"; table: PoolTableView }
  | { type: "pool"; ev: "shot"; shot: PoolShot; game: PoolGame; version: number }
  | { type: "pool"; ev: "aim"; a: number; p: number; x: number | null; y: number | null }
  /** 本地事件：同步通道重新连上，打开着的面板需要重新订阅 */
  | { type: "pool"; ev: "reconnect" };

export type PoolClientMessage =
  | { op: "watch" | "unwatch" | "solo" | "leave" | "rematch" }
  | { op: "sit"; seat: PoolSeat }
  | { op: "aim"; a: number; p: number; x?: number; y?: number }
  | { op: "shot"; shot: PoolShot; game: PoolGame };

type Sender = (payload: object) => boolean;

let sender: Sender | null = null;
const listeners = new Set<(message: PoolServerMessage) => void>();
const summaryListeners = new Set<(summary: PoolSummary) => void>();
let summary: PoolSummary = { left: null, right: null, status: "open", solo: false };

/** PresenceClient 建立时绑定发送函数，销毁时传 null */
export function bindPoolSender(fn: Sender | null) {
  sender = fn;
}

/** 发送台球消息；连接未就绪时返回 false */
export function sendPool(message: PoolClientMessage): boolean {
  return sender ? sender({ type: "pool", ...message }) : false;
}

/** PresenceClient 收到台球相关消息时调用 */
export function emitPool(message: PoolServerMessage | ({ type: "pool-summary" } & PoolSummary)) {
  if (message.type === "pool-summary") {
    summary = { left: message.left, right: message.right, status: message.status, solo: message.solo };
    summaryListeners.forEach(fn => fn(summary));
    return;
  }
  listeners.forEach(fn => fn(message));
}

export function onPool(fn: (message: PoolServerMessage) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function onPoolSummary(fn: (summary: PoolSummary) => void): () => void {
  summaryListeners.add(fn);
  fn(summary);
  return () => {
    summaryListeners.delete(fn);
  };
}

/** 当前打开的台球面板看到的球桌，供对话框关闭前确认 */
let activeTable: PoolTableView | null = null;

export function setActivePoolTable(table: PoolTableView | null) {
  activeTable = table;
}

/** 关闭台球面板前的提示：双人对局进行中离开会判负 */
export function poolCloseWarning(): string | null {
  const table = activeTable;
  if (!table || !table.you.length || table.solo || table.status !== "playing") return null;
  return "对局还没结束，离开球桌会判负。确定离开吗？";
}

export const POOL_SEAT_LABEL: Record<PoolSeat, string> = { left: "左侧", right: "右侧" };
