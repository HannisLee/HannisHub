"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { Button } from "../../ui/primitives";

export function DeskBrowserPanel() {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; url?: string; error?: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ url: string }>("/api/chat-lobby/desk-browser/start", { method: "POST", signal: controller.signal })
      .then(({ url }) => { if (!controller.signal.aborted) setResult({ attempt, url }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ attempt, error: error instanceof Error ? error.message : "无法启动工位浏览器" });
        }
      });
    return () => controller.abort();
  }, [attempt]);

  if (result?.attempt !== attempt) {
    return <div className="desk-browser-status" role="status">正在启动你的浏览器…</div>;
  }
  if (result.error) {
    return (
      <div className="desk-browser-status" role="status">
        <span>{result.error}</span>
        <Button onClick={() => setAttempt(attempt + 1)}>重试</Button>
      </div>
    );
  }
  return (
    <iframe
      className="desk-browser-frame"
      title="我的工位浏览器"
      src={result.url}
      allow="clipboard-read; clipboard-write; fullscreen"
    />
  );
}
