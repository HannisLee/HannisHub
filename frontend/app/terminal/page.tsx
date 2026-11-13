import { AppShell } from "../../components/layout/app-shell";
import { TerminalWorkspace } from "../../components/terminal/terminal-workspace";

export default function TerminalPage() {
  return <AppShell contentClassName="terminal-page"><TerminalWorkspace /></AppShell>;
}
