import { ChatRoom } from "../../../components/chatworld/room/chat-room";
import { AppShell } from "../../../components/layout/app-shell";

export default function ChatPage() {
  return <AppShell contentClassName="chat-page"><ChatRoom /></AppShell>;
}
