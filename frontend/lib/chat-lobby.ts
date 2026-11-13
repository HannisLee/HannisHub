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
