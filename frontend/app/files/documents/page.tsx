import { AppShell } from "../../../components/layout/app-shell";
import { DocumentViewer } from "../../../components/file-manager/document-viewer";

export default function DocumentsPage() {
  return <AppShell contentClassName="document-viewer-page"><DocumentViewer /></AppShell>;
}
