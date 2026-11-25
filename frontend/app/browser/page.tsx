import { AppShell } from "../../components/layout/app-shell";

export default function BrowserPage() {
  return (
    <AppShell contentClassName="remote-browser-page">
      <iframe
        className="remote-browser-frame"
        title="服务器上的 Google Chrome"
        src="/browser/session/"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </AppShell>
  );
}
