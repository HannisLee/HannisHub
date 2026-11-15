"use client";

import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { API_PATHS } from "../../lib/api";
import { clipboardShortcut } from "../../lib/terminal-clipboard";

/** 终端结束原因：exit = shell 自己退出，released = 空闲回收，closed = 被关闭，missing = 已不存在 */
export type TerminalEndReason = "exit" | "released" | "closed" | "missing" | "forbidden";

interface TerminalViewProps {
  sessionId: string;
  active: boolean;
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

export default function TerminalView({ sessionId, active, onEnded, onActivity, onStatus }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.attachCustomKeyEventHandler(event => {
      const shortcut = clipboardShortcut(event, term.hasSelection());
      if (!shortcut) return true;
      if (shortcut === "copy-command") {
        event.preventDefault();
        // 在按键手势内同步触发 copy 事件，由 xterm 的 copy 监听写入选中文字
        if (term.hasSelection()) document.execCommand("copy");
      }
      // 返回 false：xterm 不处理也不 preventDefault，浏览器继续触发原生 paste / copy
      return false;
    });
    termRef.current = term;
    fitRef.current = fit;

    let socket: WebSocket | null = null;
    let disposed = false;
    let ended = false;
    let retryDelay = 500;
    let retryTimer: number | undefined;
    let resizeTimer: number | undefined;

    const send = (message: object) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const sendSize = () => send({ type: "resize", cols: term.cols, rows: term.rows });
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
        term.reset();
        if (activeRef.current) fit.fit();
        sendSize();
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
    // 只有可见时才按容器尺寸重算行列；隐藏标签的容器尺寸为 0
    const observer = new ResizeObserver(() => {
      if (activeRef.current && host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
    observer.observe(host);
    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      dataListener.dispose();
      resizeListener.dispose();
      socket?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  return <div className="terminal-view" ref={hostRef} hidden={!active} />;
}
