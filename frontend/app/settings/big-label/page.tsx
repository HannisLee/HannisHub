"use client";

import { useEffect, useState } from "react";
import { AppShell } from "../../../components/layout/app-shell";

export default function BigLabelPage() {
  const [text, setText] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!visible) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setVisible(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  return <AppShell>
    <header className="page-header"><h1 className="page-title">大Label</h1></header>
    <form onSubmit={event => { event.preventDefault(); if (text.trim()) setVisible(true); }} style={{ display: "flex", gap: 12, alignItems: "start" }}>
      <textarea aria-label="展示文字" placeholder="输入要展示的文字" value={text} onChange={event => setText(event.target.value)} rows={3} style={{ flex: 1, minWidth: 0 }} />
      <button type="submit" disabled={!text.trim()} className="btn">展示</button>
    </form>
    {visible && <div role="dialog" aria-modal="true" aria-label="大Label展示" style={{ position: "fixed", inset: 0, zIndex: 9999, background: "#111", color: "white", display: "flex", alignItems: "center", justifyContent: "center", padding: "4vw", overflow: "auto" }}>
      <button type="button" onClick={() => setVisible(false)} aria-label="关闭展示" style={{ position: "fixed", top: 16, right: 20, fontSize: 28, color: "white", background: "transparent", border: 0, cursor: "pointer" }}>×</button>
      <div style={{ fontSize: `clamp(2rem, ${Math.max(4, Math.min(20, 100 / Math.sqrt(text.length)))}vw, 20rem)`, fontWeight: 700, textAlign: "center", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "100%", overflow: "auto", width: "100%" }}>{text}</div>
    </div>}
  </AppShell>;
}
