"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { DeskComputer, PrivatePanel } from "./private-panel";
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { setChatEmbedded } from "../../../lib/chat-notify";
import { fetchLinkupSettings, linkupCloseWarning } from "../../../lib/lobby-linkup";
import { poolCloseWarning } from "../../../lib/lobby-pool";
import { useShell } from "../../layout/shell-context";
import type { MachineInfo } from "./game/layout";

function PanelLoading() {
  return <div className="lobby-machine-loading"><span className="loading-line" /></div>;
}

const AsrPanel = dynamic(() => import("../../llama/asr-panel").then(m => m.AsrPanel), { ssr: false, loading: PanelLoading });
const OcrPanel = dynamic(() => import("../../llama/ocr-panel").then(m => m.OcrPanel), { ssr: false, loading: PanelLoading });
const ChatRoom = dynamic(() => import("../room/chat-room").then(m => m.ChatRoom), { ssr: false, loading: PanelLoading });
const NotesBoard = dynamic(() => import("./notes-board").then(m => m.NotesBoard), { ssr: false, loading: PanelLoading });
const PoolPanel = dynamic(() => import("../pool/pool-panel").then(m => m.PoolPanel), { ssr: false, loading: PanelLoading });
const LinkupPanel = dynamic(() => import("../linkup/linkup-panel").then(m => m.LinkupPanel), { ssr: false, loading: PanelLoading });

const PianoPanel = dynamic(() => import("../piano/piano-panel").then(m => m.PianoPanel), { ssr: false, loading: PanelLoading });

/** 内嵌聊天室：打开期间暂停页面级的后台新消息检查，避免对正在看的消息弹提示、响提示音 */
function ChatPanel() {
  useEffect(() => {
    setChatEmbedded(true);
    return () => setChatEmbedded(false);
  }, []);
  return <ChatRoom embedded />;
}

/** 面对面私聊：交谈对象由场景编号（machine.hint）决定 */
function NearPrivate({ machine, onClose }: { machine: MachineInfo; onClose: () => void }) {
  return <PrivatePanel mode="near" sceneId={machine.hint} onClose={onClose} />;
}

/** 私聊提醒打开的收件箱：初始选中来信的联系人（machine.hint） */
function InboxPrivate({ machine, onClose }: { machine: MachineInfo; onClose: () => void }) {
  return <PrivatePanel mode="inbox" contactId={machine.hint} onClose={onClose} />;
}

function DeskPanel({ onClose }: { onClose: () => void }) {
  return <DeskComputer onClose={onClose} />;
}

type PanelProps = { machine: MachineInfo; onClose: () => void };

/** 大厅机器 → 对应的功能面板与独立页面地址（留言板没有独立页面）；
 *  fill 表示面板铺满对话框（自带滚动区）；compact 为较小的对话框（私聊）；hint 覆盖标题栏说明 */
const POOL_ENTRY = { Panel: PoolPanel, fill: true, hint: "中式八球 · 两端入座对战，或一个人打两边", confirmClose: poolCloseWarning };

const MACHINES: Record<string, {
  Panel: ComponentType<PanelProps> | ComponentType;
  href?: string;
  fill?: boolean;
  compact?: boolean;
  hint?: string;
  /** 关闭前的确认提示：返回文字时先询问，取消则不关闭 */
  confirmClose?: () => string | null;
}> = {
  asr: { Panel: AsrPanel, href: "/llama/asr" },
  ocr: { Panel: OcrPanel, href: "/llama/ocr" },
  chat: { Panel: ChatPanel, href: "/chat", fill: true },
  private: { Panel: NearPrivate, fill: true, compact: true, hint: "面对面交谈 · 走开后结束" },
  inbox: { Panel: InboxPrivate, fill: true, compact: true, hint: "收到的私聊可在任意位置查看和回复" },
  todo: { Panel: DeskPanel, href: "/todo", fill: true },
  notes: { Panel: NotesBoard },
  piano: { Panel: PianoPanel, fill: true, hint: "模拟钢琴 · 键盘 / 鼠标 / 触屏演奏" },
  pool: POOL_ENTRY,
  "pool-left": POOL_ENTRY,
  "pool-right": POOL_ENTRY,
  linkup: { Panel: LinkupPanel, fill: true, hint: "连连看 · 闯关 / 每日挑战 / 休闲", confirmClose: linkupCloseWarning },
};

interface MachineDialogProps {
  machine: MachineInfo;
  onClose: () => void;
  /** 标题栏右侧的额外操作（如工位待办的「退还工位」） */
  actions?: ReactNode;
}

/** 机器交互面板：全屏遮罩上的大尺寸对话框，内嵌 ASR / OCR / 聊天室 / 工位待办原有页面组件。Esc 或点击遮罩关闭；
 *  面板内部已处理的 Esc（如关闭表情面板、大图预览）不会连带关闭对话框。 */
export function MachineDialog({ machine, onClose: close, actions }: MachineDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [linkupAccess, setLinkupAccess] = useState<"loading" | "allowed" | "denied" | "error">("loading");
  const isLinkup = machine.id === "linkup";
  const notice = isLinkup && (linkupAccess === "denied" || linkupAccess === "error");
  const entry = MACHINES[machine.id];
  const confirmClose = entry?.confirmClose;
  const onClose = useCallback(() => {
    const warning = confirmClose?.();
    if (warning && !window.confirm(warning)) return;
    close();
  }, [close, confirmClose]);
  // 整页模式（普通账号）不提供跳出游戏的独立页面入口
  const immersive = useShell()?.immersive ?? false;

  useEffect(() => {
    if (!isLinkup) return;
    const controller = new AbortController();
    void fetchLinkupSettings(controller.signal).then(settings => {
      if (!controller.signal.aborted) setLinkupAccess(settings.enabled ? "allowed" : "denied");
    }).catch(() => {
      if (!controller.signal.aborted) setLinkupAccess("error");
    });
    return () => controller.abort();
  }, [isLinkup]);

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
  }, [notice, onClose]);

  if (!entry) return null;
  const { Panel, href, fill, compact, hint } = entry;

  return createPortal(
    <div className="lobby-machine-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      {notice ? (
        <section className="lobby-claim" role="alertdialog" aria-modal="true" aria-labelledby="lobby-machine-title">
          <h2 id="lobby-machine-title" className="lobby-claim-title">
            {linkupAccess === "denied" ? "孙倩茹禁止玩连连看" : "无法读取连连看设置，请稍后再试。"}
          </h2>
          <div className="lobby-claim-actions">
            <button ref={closeRef} type="button" className="button button-primary button-md" onClick={onClose}>确定</button>
          </div>
        </section>
      ) : (
        <section className={`lobby-machine${compact ? " is-compact" : ""}`} role="dialog" aria-modal="true" aria-labelledby="lobby-machine-title">
          <header className="lobby-machine-bar">
            <div className="lobby-machine-name">
              <span className="lobby-dot" aria-hidden="true" />
              <span id="lobby-machine-title">{machine.title}</span>
              <span className="lobby-machine-hint">{hint ?? machine.hint}</span>
            </div>
            <div className="lobby-machine-actions">
              {actions}
              {immersive || !href ? null : <Link href={href} className="lobby-machine-link">在独立页面打开</Link>}
              <button ref={closeRef} type="button" className="lobby-machine-close" onClick={onClose} aria-label="关闭面板，回到大厅">
                <kbd>Esc</kbd>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
              </button>
            </div>
          </header>
          <div className={`lobby-machine-body${fill ? " is-fill" : ""}`}>
            {isLinkup && linkupAccess !== "allowed" ? <PanelLoading /> : <Panel machine={machine} onClose={onClose} />}
          </div>
        </section>
      )}
    </div>,
    document.body,
  );
}
