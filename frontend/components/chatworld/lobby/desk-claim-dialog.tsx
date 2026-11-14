"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface DeskClaimDialogProps {
  /** 自己已有工位：认领新工位会退还原来的 */
  hasDesk: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 在空闲工位坐下时询问是否认领：认领后挂上名牌，以后坐到这里按 E 打开待办。Esc 或点击遮罩只坐不认领。 */
export function DeskClaimDialog({ hasDesk, error, onConfirm, onCancel }: DeskClaimDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onCancel();
    };
    window.addEventListener("keydown", onKey);
    confirmRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="lobby-machine-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="lobby-claim" role="dialog" aria-modal="true" aria-labelledby="lobby-claim-title">
        <h2 id="lobby-claim-title" className="lobby-claim-title">认领这个工位？</h2>
        <p className="lobby-claim-text">
          认领后桌上会挂上你的名牌；以后坐到自己的工位上按 <kbd className="lobby-key">E</kbd> 就能打开待办清单。
          {hasDesk ? "每人只有一个工位，你原来的工位会被退还。" : "每人只能认领一个工位。"}
        </p>
        {error ? <p className="lobby-claim-error" role="alert">{error}</p> : null}
        <div className="lobby-claim-actions">
          <button type="button" className="button button-secondary button-md" onClick={onCancel}>只是坐坐</button>
          <button ref={confirmRef} type="button" className="button button-primary button-md" onClick={onConfirm}>认领并打开待办</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
