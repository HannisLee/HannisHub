import { AppShell } from "../../../components/layout/app-shell";
import { ServerFilesPanel } from "../../../components/file-manager/server-files-panel";

export default function ServerFilesPage() {
  return <AppShell contentClassName="file-manager-page"><ServerFilesPanel /></AppShell>;
}
