import { AppShell } from "../../components/layout/app-shell";
import { PromptFloat } from "../../components/prompts/prompt-float";
import { TerminalWorkspace } from "../../components/terminal/terminal-workspace";

export default function TerminalPage() {
  return (
    <AppShell contentClassName="terminal-page">
      <TerminalWorkspace />
      <PromptFloat />
    </AppShell>
  );
}
