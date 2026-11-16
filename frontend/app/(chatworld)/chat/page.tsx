import { ChatRoom } from "../../../components/chatworld/room/chat-room";
import { FeatureBoard } from "../../../components/chatworld/room/feature-board";
import { AppShell } from "../../../components/layout/app-shell";

export default function ChatPage() {
  return (
    <AppShell contentClassName="chat-page">
      <div className="chat-layout">
        <ChatRoom />
        <FeatureBoard />
      </div>
    </AppShell>
  );
}
