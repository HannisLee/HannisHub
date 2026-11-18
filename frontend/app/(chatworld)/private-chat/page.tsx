import { AppShell } from "../../../components/layout/app-shell";
import { PrivatePanel } from "../../../components/chatworld/lobby/private-panel";

/** 管理员直接使用工位电脑的私聊，无需进入大厅场景。 */
export default function PrivateChatPage() {
  return <AppShell><div className="private-page"><PrivatePanel mode="desk" /></div></AppShell>;
}
