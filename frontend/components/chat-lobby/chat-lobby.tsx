"use client";

import dynamic from "next/dynamic";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { TouchState } from "../../game/lobby/player";

const LobbyCanvas = dynamic(() => import("./lobby-canvas"), {
  ssr: false,
  loading: () => <div className="lobby-canvas-host" />,
});

type Phase = "loading" | "ready" | "error";

// 方向垫与游戏循环共享的输入对象：事件写入、Phaser 每帧读取，绕过 React 渲染
const touchInput: TouchState = { x: 0, y: 0 };

const COARSE_QUERY = "(pointer: coarse)";

function subscribeCoarse(onChange: () => void) {
  const query = window.matchMedia(COARSE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function coarseSnapshot() {
  return window.matchMedia(COARSE_QUERY).matches;
}

const coarseServerSnapshot = () => false;

function Key({ children }: { children: string }) {
  return <kbd className="lobby-key">{children}</kbd>;
}

export function ChatLobby() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const coarse = useSyncExternalStore(subscribeCoarse, coarseSnapshot, coarseServerSnapshot);

  const onProgress = useCallback((value: number) => setProgress(value), []);
  const onReady = useCallback(() => setPhase("ready"), []);
  const onError = useCallback((message: string) => {
    setError(message);
    setPhase("error");
  }, []);

  const retry = useCallback(() => {
    setPhase("loading");
    setProgress(0);
    setError("");
    setRetryKey(k => k + 1);
  }, []);

  const press = (x: number, y: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    touchInput.x = x;
    touchInput.y = y;
  };
  const release = () => {
    touchInput.x = 0;
    touchInput.y = 0;
  };

  return (
    <div className="lobby">
      <header className="lobby-head">
        <div>
          <h1 className="lobby-title">聊天大厅</h1>
          <p className="lobby-subtitle">像素客厅 · 单人场景预览</p>
        </div>
        <div className="lobby-hint" aria-label="操作提示">
          <span className="lobby-hint-keys"><Key>W</Key><Key>A</Key><Key>S</Key><Key>D</Key></span>
          <span className="lobby-hint-text">或方向键移动</span>
        </div>
      </header>

      <div className="lobby-stage">
        <LobbyCanvas key={retryKey} touch={touchInput} onProgress={onProgress} onReady={onReady} onError={onError} />

        {phase === "loading" ? (
          <div className="lobby-overlay">
            <span className="loading-line" />
            <p>正在加载大厅素材… {Math.round(progress * 100)}%</p>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="lobby-overlay">
            <p className="lobby-error-text">{error || "场景初始化失败"}</p>
            <button type="button" className="lobby-retry" onClick={retry}>重试</button>
          </div>
        ) : null}

        {coarse && phase === "ready" ? (
          <div className="lobby-dpad" aria-label="移动方向垫">
            <button type="button" className="lobby-dpad-btn lobby-dpad-up" aria-label="上" onPointerDown={press(0, -1)} onPointerUp={release} onPointerCancel={release}>▲</button>
            <button type="button" className="lobby-dpad-btn lobby-dpad-left" aria-label="左" onPointerDown={press(-1, 0)} onPointerUp={release} onPointerCancel={release}>◀</button>
            <button type="button" className="lobby-dpad-btn lobby-dpad-right" aria-label="右" onPointerDown={press(1, 0)} onPointerUp={release} onPointerCancel={release}>▶</button>
            <button type="button" className="lobby-dpad-btn lobby-dpad-down" aria-label="下" onPointerDown={press(0, 1)} onPointerUp={release} onPointerCancel={release}>▼</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}