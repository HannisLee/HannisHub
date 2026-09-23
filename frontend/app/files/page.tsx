import { AppShell } from "../../components/layout/app-shell";
import { FileManagerPanel } from "../../components/file-manager/file-manager-panel";

export default function FilesPage() {
  return <AppShell contentClassName="file-manager-page"><FileManagerPanel /></AppShell>;
}
