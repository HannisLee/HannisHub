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

/** 自己上报的状态：位于私有房间（我的房间）时服务端只保留房间编号 */
export interface LobbyLocalState {
  room: string;
  x: number;
  y: number;
  dir: LobbyFacing;
  moving: boolean;
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
  | { type: "profile"; id: string; name: string; avatar: LobbyAvatar | null };

export function lobbySocketUrl(): string {
  const override = process.env.NEXT_PUBLIC_HANNISHUB_WS_ORIGIN;
  const origin = override || `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  return `${origin}${API_PATHS.chatLobby}/ws`;
}
