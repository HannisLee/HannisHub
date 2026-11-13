import { AppShell } from "../../../components/layout/app-shell";
import { ChatLobby } from "../../../components/chatworld/lobby/chat-lobby";

/** 管理员在完整外壳中使用聊天大厅；普通账号整页进入游戏 */
export default function ChatLobbyPage() {
  return <AppShell contentClassName="chat-lobby-page" immersiveForRegular><ChatLobby /></AppShell>;
}
