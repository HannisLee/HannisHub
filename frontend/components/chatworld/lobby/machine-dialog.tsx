"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, type ComponentType } from "react";
import { createPortal } from "react-dom";
import type { MachineInfo } from "./game/layout";

function PanelLoading() {
  return <div className="lobby-machine-loading"><span className="loading-line" /></div>;
}

const AsrPanel = dynamic(() => import("../../llama/asr-panel").then(m => m.AsrPanel), { ssr: false, loading: PanelLoading });
const OcrPanel = dynamic(() => import("../../llama/ocr-panel").then(m => m.OcrPanel), { ssr: false, loading: PanelLoading });

/** 大厅机器 → 对应的功能面板与独立页面地址 */
const MACHINES: Record<string, { Panel: ComponentType; href: string }> = {
  asr: { Panel: AsrPanel, href: "/llama/asr" },
  ocr: { Panel: OcrPanel, href: "/llama/ocr" },
};

interface MachineDialogProps {
  machine: MachineInfo;
  onClose: () => void;
}

/** 机器交互面板：全屏遮罩上的大尺寸对话框，内嵌 ASR / OCR 原有页面组件。Esc 或点击遮罩关闭。 */
export function MachineDialog({ machine, onClose }: MachineDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const entry = MACHINES[machine.id];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  if (!entry) return null;
  const { Panel, href } = entry;

  return createPortal(
    <div className="lobby-machine-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="lobby-machine" role="dialog" aria-modal="true" aria-labelledby="lobby-machine-title">
        <header className="lobby-machine-bar">
          <div className="lobby-machine-name">
            <span className="lobby-dot" aria-hidden="true" />
            <span id="lobby-machine-title">{machine.title}</span>
            <span className="lobby-machine-hint">{machine.hint}</span>
          </div>
          <div className="lobby-machine-actions">
            <Link href={href} className="lobby-machine-link">在独立页面打开</Link>
            <button ref={closeRef} type="button" className="lobby-machine-close" onClick={onClose} aria-label="关闭面板，回到大厅">
              <kbd>Esc</kbd>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        </header>
        <div className="lobby-machine-body">
          <Panel />
        </div>
      </section>
    </div>,
    document.body,
  );
}
