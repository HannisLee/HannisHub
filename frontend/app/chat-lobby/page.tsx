import { AppShell } from "../../components/layout/app-shell";
import { ChatLobby } from "../../components/chat-lobby/chat-lobby";

export default function ChatLobbyPage() {
  return <AppShell contentClassName="chat-lobby-page"><ChatLobby /></AppShell>;
}