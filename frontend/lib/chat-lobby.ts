import { API_PATHS, apiFetch, jsonBody } from "./api";

/** 像素形象的 5 个部件槽位：保存部件编号，发型与配饰可为空字符串（不戴） */
export interface LobbyAvatar {
  body: string;
  eyes: string;
  outfit: string;
  hair: string;
  accessory: string;
}

/** 当前账号在聊天大厅中的资料；avatar 为 null 时使用场景默认角色 */
export interface LobbyProfile {
  username: string;
  /** 多人同场时显示在其他人看到的角色头顶 */
  name: string;
  avatar: LobbyAvatar | null;
  updated_at: number | null;
}

export const LOBBY_NAME_MAX = 16;

export function fetchLobbyProfile(): Promise<LobbyProfile> {
  return apiFetch<LobbyProfile>(`${API_PATHS.chatLobby}/profile`);
}

export function saveLobbyProfile(name: string, avatar: LobbyAvatar | null): Promise<LobbyProfile> {
  return apiFetch<LobbyProfile>(`${API_PATHS.chatLobby}/profile`, {
    method: "PUT",
    body: jsonBody({ name, avatar }),
  });
}

/** ---------- 多人同步（WebSocket /api/chat-lobby/ws），协议见 chatworld/lobby_presence.py ---------- */

export type LobbyFacing = "down" | "up" | "left" | "right";

/** 姿势：空字符串为站立 / 行走，"sit" 为坐着（dir 为坐下的朝向） */
export type LobbyPose = "" | "sit";

/** 自己上报的状态：位于私有房间（我的房间）时服务端只保留房间编号 */
export interface LobbyLocalState {
  room: string;
  x: number;
  y: number;
  dir: LobbyFacing;
  moving: boolean;
  pose?: LobbyPose;
}

/** 公共房间（入口厅、大厅）里的其他人；id 为服务端随机生成的角色编号 */
export interface LobbyRemotePlayer extends LobbyLocalState {
  id: string;
  name: string;
  avatar: LobbyAvatar | null;
}

export type LobbyServerMessage =
  | { type: "snapshot"; players: LobbyRemotePlayer[] }
  | { type: "player"; player: LobbyRemotePlayer }
  | ({ type: "move"; id: string } & LobbyLocalState)
  | { type: "hide"; id: string }
  | { type: "leave"; id: string }
  | { type: "profile"; id: string; name: string; avatar: LobbyAvatar | null }
  | { type: "emote"; id: string; key: string }
  | { type: "say"; id: string; text: string }
  | { type: "desks" }
  | { type: "notes" };

export function lobbySocketUrl(): string {
  const override = process.env.NEXT_PUBLIC_HANNISHUB_WS_ORIGIN;
  const origin = override || `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  return `${origin}${API_PATHS.chatLobby}/ws`;
}

/** ---------- 表情气泡：键名经服务端校验后广播，文字由各端本地决定 ---------- */

/** 表情键 → 可选文字（随机取一条）。自己看到随机一条，其他人看到第一条 */
export const LOBBY_EMOTES: Record<string, string[]> = {
  wave: ["嗨！"],
  laugh: ["哈哈哈"],
  like: ["赞！"],
  think: ["嗯……"],
  coffee: ["咖啡续上了", "再来一杯", "提神中"],
  fridge: ["拿了瓶汽水", "冰淇淋！", "牛奶快喝完了"],
  snack: ["咔嚓咔嚓", "薯片真香", "就吃一包"],
  fish: ["喂鱼中", "小鱼游过来了", "别抢别抢"],
  // 与猫互动的随机反应（场景里还会播放对应的动作：爱心、翻身、Zzz、跑开、回一声喵）
  catpurr: ["猫蹭了蹭你的手，呼噜呼噜～"],
  catflip: ["猫翻了个身，露出肚皮"],
  catzzz: ["猫看了你一眼，又睡着了"],
  catrun: ["猫被吵醒，溜达了一圈"],
  catmeow: ["喵～"],
  plant: ["浇浇水", "又长高了", "叶子很精神"],
  train: ["呜呜——", "小火车出发", "绕圈圈"],
  book: ["读书中", "这本不错", "翻了几页"],
  board: ["看白板", "先做最重要的事", "完成比完美更重要", "大任务拆成小步骤", "记得喝水", "专注 25 分钟，休息 5 分钟"],
  arcade: ["来一局！", "新纪录！", "再来一局", "Game Over"],
  pinball: ["叮叮叮", "高分！", "球掉了……"],
  pool: ["打一杆", "一杆进洞！", "差一点点", "清台！"],
  piano: ["♪ ♫ ♪"],
  guitar: ["♪ 拨弦"],
};

/** 数字键 1–4 对应的快捷表情 */
export const QUICK_EMOTES = ["wave", "laugh", "like", "think"] as const;

/** ---------- 工位（GET/PUT/DELETE /api/chat-lobby/desks） ---------- */

export interface LobbyDeskState {
  /** 已认领的工位：工位编号 → { name, mine } */
  desks: Record<string, { name: string; mine: boolean }>;
  /** 自己认领的工位编号；没有时为 null */
  mine: string | null;
}

export function fetchLobbyDesks(): Promise<LobbyDeskState> {
  return apiFetch<LobbyDeskState>(`${API_PATHS.chatLobby}/desks`);
}

/** 认领工位：已有工位时改为这一个；已被别人认领时返回 409 */
export function claimLobbyDesk(desk: string): Promise<LobbyDeskState> {
  return apiFetch<LobbyDeskState>(`${API_PATHS.chatLobby}/desks/mine`, { method: "PUT", body: jsonBody({ desk }) });
}

export function releaseLobbyDesk(): Promise<LobbyDeskState> {
  return apiFetch<LobbyDeskState>(`${API_PATHS.chatLobby}/desks/mine`, { method: "DELETE" });
}

/** 回车说话的最大字数（与服务端 chatworld/lobby_presence.py 的 MAX_SAY_CHARS 一致） */
export const LOBBY_SAY_MAX = 60;

/** ---------- 留言板（/api/chat-lobby/notes）：大厅里所有人共享的便签墙 ---------- */

export const NOTE_COLORS = ["yellow", "pink", "blue", "green", "orange", "purple"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export const NOTE_TEXT_MAX = 140;

export interface LobbyNote {
  id: string;
  /** 作者在大厅中的显示名字（贴出时的名字） */
  name: string;
  text: string;
  color: NoteColor;
  /** 自己贴的便签（可以撕掉） */
  mine: boolean;
  created_at: number;
}

export interface LobbyNotesState {
  notes: LobbyNote[];
  /** 管理员可以撕掉任何人的便签 */
  can_moderate: boolean;
}

export function fetchLobbyNotes(): Promise<LobbyNotesState> {
  return apiFetch<LobbyNotesState>(`${API_PATHS.chatLobby}/notes`);
}

export function postLobbyNote(text: string, color: NoteColor): Promise<LobbyNote> {
  return apiFetch<LobbyNote>(`${API_PATHS.chatLobby}/notes`, { method: "POST", body: jsonBody({ text, color }) });
}

export function deleteLobbyNote(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`${API_PATHS.chatLobby}/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 留言板变化事件：场景收到同步通道的 notes 通知后在 window 上派发 */
export const LOBBY_NOTES_EVENT = "hannishub:lobby-notes";
