import { AppShell } from "../../../components/layout/app-shell";
import { TodoPanel } from "../../../components/chatworld/todo/todo-panel";

/** 工位待办独立页面：与聊天大厅里「我的工位」打开的是同一份清单 */
export default function TodoPage() {
  return <AppShell><TodoPanel /></AppShell>;
}
