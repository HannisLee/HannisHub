import { AppShell } from "../../../components/layout/app-shell";
import { ChatLobby } from "../../../components/chatworld/lobby/chat-lobby";

export default function ChatLobbyPage() {
  return <AppShell contentClassName="chat-lobby-page"><ChatLobby /></AppShell>;
}