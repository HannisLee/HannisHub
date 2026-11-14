"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { setChatEmbedded } from "../../../lib/chat-notify";
import { useShell } from "../../layout/shell-context";
import type { MachineInfo } from "./game/layout";

function PanelLoading() {
  return <div className="lobby-machine-loading"><span className="loading-line" /></div>;
}

const AsrPanel = dynamic(() => import("../../llama/asr-panel").then(m => m.AsrPanel), { ssr: false, loading: PanelLoading });
const OcrPanel = dynamic(() => import("../../llama/ocr-panel").then(m => m.OcrPanel), { ssr: false, loading: PanelLoading });
const ChatRoom = dynamic(() => import("../room/chat-room").then(m => m.ChatRoom), { ssr: false, loading: PanelLoading });
const TodoPanel = dynamic(() => import("../todo/todo-panel").then(m => m.TodoPanel), { ssr: false, loading: PanelLoading });

/** 内嵌聊天室：打开期间暂停页面级的后台新消息检查，避免对正在看的消息弹提示、响提示音 */
function ChatPanel() {
  useEffect(() => {
    setChatEmbedded(true);
    return () => setChatEmbedded(false);
  }, []);
  return <ChatRoom />;
}

/** 大厅机器 → 对应的功能面板与独立页面地址；fill 表示面板铺满对话框（自带滚动区） */
const MACHINES: Record<string, { Panel: ComponentType; href: string; fill?: boolean }> = {
  asr: { Panel: AsrPanel, href: "/llama/asr" },
  ocr: { Panel: OcrPanel, href: "/llama/ocr" },
  chat: { Panel: ChatPanel, href: "/chat", fill: true },
  todo: { Panel: TodoPanel, href: "/todo" },
};

interface MachineDialogProps {
  machine: MachineInfo;
  onClose: () => void;
  /** 标题栏右侧的额外操作（如工位待办的「退还工位」） */
  actions?: ReactNode;
}

/** 机器交互面板：全屏遮罩上的大尺寸对话框，内嵌 ASR / OCR / 聊天室 / 工位待办原有页面组件。Esc 或点击遮罩关闭；
 *  面板内部已处理的 Esc（如关闭表情面板、大图预览）不会连带关闭对话框。 */
export function MachineDialog({ machine, onClose, actions }: MachineDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const entry = MACHINES[machine.id];
  // 整页模式（普通账号）不提供跳出游戏的独立页面入口
  const immersive = useShell()?.immersive ?? false;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
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
  const { Panel, href, fill } = entry;

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
            {actions}
            {immersive ? null : <Link href={href} className="lobby-machine-link">在独立页面打开</Link>}
            <button ref={closeRef} type="button" className="lobby-machine-close" onClick={onClose} aria-label="关闭面板，回到大厅">
              <kbd>Esc</kbd>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        </header>
        <div className={`lobby-machine-body${fill ? " is-fill" : ""}`}>
          <Panel />
        </div>
      </section>
    </div>,
    document.body,
  );
}
