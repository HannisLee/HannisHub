"use client";

import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { API_PATHS } from "../../lib/api";
import { clipboardShortcut } from "../../lib/terminal-clipboard";
import { bindTerminalSelection } from "../../lib/terminal-selection";
import { copyToClipboard } from "../../lib/clipboard";

/** 终端结束原因：exit = shell 自己退出，released = 空闲回收，closed = 被关闭，missing = 已不存在 */
export type TerminalEndReason = "exit" | "released" | "closed" | "missing" | "forbidden";

interface TerminalViewProps {
  sessionId: string;
  active: boolean;
  selectionMode: boolean;
  onEnded: (id: string, reason: TerminalEndReason) => void;
  onActivity: (id: string) => void;
  onStatus: (id: string, connected: boolean) => void;
}

const CLOSE_RELEASED = 4000;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_NOT_FOUND = 4404;
const MAX_RETRY_DELAY = 10_000;

function socketUrl(id: string): string {
  const override = process.env.NEXT_PUBLIC_HANNISHUB_WS_ORIGIN;
  const origin = override || `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  return `${origin}${API_PATHS.terminal}/sessions/${encodeURIComponent(id)}/ws`;
}

/** 从 design.md 落地的 CSS Variables 读取终端配色，ANSI 色板取与暖黑背景协调的低饱和色 */
function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--color-surface-soft", "#1B1B19"),
    foreground: token("--color-text-primary", "#FAF9F5"),
    cursor: token("--color-brand", "#D97757"),
    cursorAccent: token("--color-surface-soft", "#1B1B19"),
    selectionBackground: "rgba(217, 119, 87, 0.32)",
    black: "#2A2927",
    red: "#D86A5E",
    green: "#8DBF73",
    yellow: "#D9B45B",
    blue: "#7FA6D1",
    magenta: "#C08BC4",
    cyan: "#7DB9B0",
    white: "#D8D6CE",
    brightBlack: "#6E6C66",
    brightRed: "#E8877B",
    brightGreen: "#A6D48C",
    brightYellow: "#E9CB7A",
    brightBlue: "#9DBEE3",
    brightMagenta: "#D4A6D8",
    brightCyan: "#9AD1C8",
    brightWhite: "#FAF9F5",
  };
}

export default function TerminalView({ sessionId, active, selectionMode, onEnded, onActivity, onStatus }: TerminalViewProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string; message: string } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const rightClickSelection = useRef("");
  const selectionRef = useRef<ReturnType<typeof bindTerminalSelection> | null>(null);
  const scheduleFitRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  // 回调放进 ref，避免父组件重渲染导致终端重建
  const callbacks = useRef({ onEnded, onActivity, onStatus });
  useEffect(() => {
    callbacks.current = { onEnded, onActivity, onStatus };
  }, [onEnded, onActivity, onStatus]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      theme: readTheme(),
      fontFamily: css.getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.attachCustomKeyEventHandler(event => {
      const shortcut = clipboardShortcut(event, term.hasSelection());
      if (!shortcut) return true;
      if (shortcut === "copy" || shortcut === "copy-command") {
        event.preventDefault();
        // xterm 选区不是浏览器原生选区，直接复制其文本，兼容 HTTP 局域网访问。
        if (term.hasSelection()) void copyToClipboard(term.getSelection());
      }
      // 粘贴交给浏览器原生事件；复制已在上面处理。
      return false;
    });
    termRef.current = term;

    let socket: WebSocket | null = null;
    let disposed = false;
    let ended = false;
    let retryDelay = 500;
    let retryTimer: number | undefined;
    let resizeTimer: number | undefined;
    let fitFrame: number | undefined;

    const send = (message: object) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const visible = () => !disposed && activeRef.current && !document.hidden && host.clientWidth > 0 && host.clientHeight > 0;
    const sendSize = () => {
      if (visible()) send({ type: "resize", cols: term.cols, rows: term.rows });
    };
    // 字体度量和屏幕缩放可能晚于外框变化；下一帧统一校准，并主动同步 PTY。
    // 即使本地行列数没变，重新获得焦点时也要纠正其他连接留下的尺寸。
    const scheduleFit = () => {
      if (!visible() || fitFrame !== undefined) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        if (!visible()) return;
        fit.fit();
        term.refresh(0, term.rows - 1);
        window.clearTimeout(resizeTimer);
        sendSize();
      });
    };
    scheduleFitRef.current = scheduleFit;
    const finish = (reason: TerminalEndReason) => {
      if (ended) return;
      ended = true;
      callbacks.current.onEnded(sessionId, reason);
    };

    const connect = () => {
      if (disposed || ended) return;
      const ws = new WebSocket(socketUrl(sessionId));
      ws.binaryType = "arraybuffer";
      socket = ws;
      ws.onopen = () => {
        retryDelay = 500;
        // 服务端会先回放输出缓冲，清屏后重新绘制，避免重连时内容重复
        selectionRef.current?.cancel();
        term.reset();
        scheduleFit();
        callbacks.current.onStatus(sessionId, true);
      };
      ws.onmessage = event => {
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as { type?: string };
            if (message.type === "exit" || message.type === "released" || message.type === "closed") finish(message.type);
          } catch {
            return;
          }
          return;
        }
        term.write(new Uint8Array(event.data as ArrayBuffer));
      };
      ws.onclose = event => {
        selectionRef.current?.cancel();
        if (socket === ws) socket = null;
        callbacks.current.onStatus(sessionId, false);
        if (disposed || ended) return;
        if (event.code === CLOSE_NOT_FOUND) return finish("missing");
        if (event.code === CLOSE_FORBIDDEN || event.code === 4401) return finish("forbidden");
        if (event.code === CLOSE_RELEASED) return finish("released");
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      };
    };

    const dataListener = term.onData(data => {
      send({ type: "input", data });
      callbacks.current.onActivity(sessionId);
    });
    const resizeListener = term.onResize(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(sendSize, 120);
    });
    // 同时观察绘制区域：字形度量变化时，外框不一定变化。
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (screen) observer.observe(screen);
    window.addEventListener("resize", scheduleFit);
    window.addEventListener("focus", scheduleFit);
    window.addEventListener("pageshow", scheduleFit);
    document.addEventListener("visibilitychange", scheduleFit);
    document.addEventListener("fullscreenchange", scheduleFit);
    window.visualViewport?.addEventListener("resize", scheduleFit);
    document.fonts.addEventListener("loadingdone", scheduleFit);
    void document.fonts.ready.then(scheduleFit);
    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(resizeTimer);
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleFit);
      window.removeEventListener("focus", scheduleFit);
      window.removeEventListener("pageshow", scheduleFit);
      document.removeEventListener("visibilitychange", scheduleFit);
      document.removeEventListener("fullscreenchange", scheduleFit);
      window.visualViewport?.removeEventListener("resize", scheduleFit);
      document.fonts.removeEventListener("loadingdone", scheduleFit);
      dataListener.dispose();
      resizeListener.dispose();
      selectionRef.current?.cancel();
      socket?.close();
      term.dispose();
      termRef.current = null;
      scheduleFitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const host = hostRef.current;
    const term = termRef.current;
    const screen = host?.querySelector<HTMLElement>(".xterm-screen");
    if (!active || !selectionMode || !host || !term || !screen) return;
    const selection = bindTerminalSelection(host, screen, term);
    selectionRef.current = selection;
    return () => {
      selectionRef.current = null;
      selection.dispose();
    };
  }, [active, selectionMode, sessionId]);

  useEffect(() => {
    activeRef.current = active;
    const frame = window.requestAnimationFrame(() => {
      if (!active) { setMenu(null); return; }
      scheduleFitRef.current?.();
      termRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { dismiss(); termRef.current?.focus(); } };
    document.addEventListener("click", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("click", dismiss); document.removeEventListener("keydown", escape); };
  }, [menu]);

  return <div className={`terminal-view${selectionMode ? " is-selecting" : ""}`} ref={hostRef} hidden={!active} onMouseDownCapture={event => {
    if (event.button !== 2) { rightClickSelection.current = ""; return; }
    const selection = window.getSelection();
    const nativeSelection = selection && hostRef.current?.contains(selection.anchorNode) && hostRef.current.contains(selection.focusNode) ? selection.toString() : "";
    // 在 xterm 或浏览器处理右键之前保存选区，避免其被右键事件清除。
    rightClickSelection.current = termRef.current?.getSelection() || nativeSelection;
    event.stopPropagation();
  }} onContextMenuCapture={event => {
    event.preventDefault();
    event.stopPropagation();
    const selection = rightClickSelection.current || termRef.current?.getSelection() || "";
    rightClickSelection.current = "";
    setMenu({ x: Math.max(0, Math.min(event.clientX, window.innerWidth - 180)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 130)), selection, message: "" });
  }}>
    {menu ? <div className="terminal-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
      <button type="button" role="menuitem" disabled={!menu.selection} onClick={() => {
        void copyToClipboard(menu.selection).then(copied => {
          if (copied) { setMenu(null); termRef.current?.focus(); }
          else setMenu(current => current && { ...current, message: "复制失败，请使用 Ctrl+Shift+C" });
        });
      }}>复制 <span>Ctrl+Shift+C</span></button>
      {menu.message ? <p role="status">{menu.message}</p> : null}
    </div> : null}
  </div>;
}
