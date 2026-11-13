"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { LobbyBridge, LobbyEvents, MachineInfo, RoomInfo } from "./game/layout";
import { MachineDialog } from "./machine-dialog";

const LobbyCanvas = dynamic(() => import("./lobby-canvas"), {
  ssr: false,
  loading: () => <div className="lobby-canvas-host" />,
});

type Phase = "loading" | "ready" | "error";

/** 每个房间的一句话引导 */
const ROOM_GUIDES: Record<string, string> = {
  foyer: "入口厅 · 穿过下方的门进入大厅",
  hall: "大厅 · 走到 ASR / OCR 机器前的地台上按 E 使用",
};

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

/** 与游戏循环共享的桥接对象：事件写入、Phaser 每帧读取，绕过 React 渲染 */
const bridge: LobbyBridge = { touch: { x: 0, y: 0 }, paused: false, interactQueued: false };

function resetBridge() {
  bridge.touch.x = 0;
  bridge.touch.y = 0;
  bridge.paused = false;
  bridge.interactQueued = false;
}

export function ChatLobby() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [nearby, setNearby] = useState<MachineInfo | null>(null);
  const [active, setActive] = useState<MachineInfo | null>(null);
  // 重试时递增，LobbyCanvas 据此重建游戏
  const [gameKey, setGameKey] = useState(0);
  const coarse = useSyncExternalStore(subscribeCoarse, coarseSnapshot, coarseServerSnapshot);

  // 离开页面时面板可能仍处于打开状态，重新进入时复位共享状态
  useEffect(() => {
    resetBridge();
    return resetBridge;
  }, []);

  const openMachine = useCallback((machine: MachineInfo) => {
    bridge.paused = true;
    bridge.touch.x = 0;
    bridge.touch.y = 0;
    setActive(machine);
  }, []);

  const closeMachine = useCallback(() => {
    bridge.paused = false;
    setActive(null);
  }, []);

  const events = useMemo<LobbyEvents>(() => ({
    onProgress: setProgress,
    onReady: () => setPhase("ready"),
    onError: message => {
      setError(message);
      setPhase("error");
    },
    onRoomChange: setRoom,
    onNearby: setNearby,
    onInteract: openMachine,
  }), [openMachine]);

  const retry = useCallback(() => {
    setPhase("loading");
    setProgress(0);
    setError("");
    setRoom(null);
    setNearby(null);
    resetBridge();
    setGameKey(k => k + 1);
  }, []);

  const press = (x: number, y: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    bridge.touch.x = x;
    bridge.touch.y = y;
  };
  const release = () => {
    bridge.touch.x = 0;
    bridge.touch.y = 0;
  };

  const ready = phase === "ready";

  return (
    <div className="lobby">
      <header className="lobby-head">
        <div>
          <h1 className="lobby-title">聊天大厅</h1>
          <p className="lobby-subtitle">{room ? ROOM_GUIDES[room.id] ?? room.name : "像素俱乐部 · 正在进入"}</p>
        </div>
        <div className="lobby-hint" aria-label="操作提示">
          <span className="lobby-hint-group">
            <span className="lobby-hint-keys"><Key>W</Key><Key>A</Key><Key>S</Key><Key>D</Key></span>
            <span className="lobby-hint-text">移动</span>
          </span>
          <span className="lobby-hint-group">
            <Key>E</Key>
            <span className="lobby-hint-text">交互</span>
          </span>
        </div>
      </header>

      <div className="lobby-stage">
        <LobbyCanvas key={gameKey} bridge={bridge} events={events} />

        {ready && room ? (
          <div className="lobby-room-chip" aria-live="polite">
            <span className="lobby-dot" aria-hidden="true" />
            {room.name}
          </div>
        ) : null}

        {ready && nearby && !active ? (
          <div className="lobby-prompt" role="status">
            <Key>E</Key>
            <span className="lobby-prompt-text">
              使用 <strong>{nearby.title}</strong>
              <span className="lobby-prompt-hint">{nearby.hint}</span>
            </span>
            {coarse ? (
              <button type="button" className="lobby-prompt-button" onClick={() => openMachine(nearby)}>使用</button>
            ) : null}
          </div>
        ) : null}

        {phase === "loading" ? (
          <div className="lobby-overlay">
            <span className="loading-line" />
            <p>正在布置大厅… {Math.round(progress * 100)}%</p>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="lobby-overlay">
            <p className="lobby-error-text">{error || "场景初始化失败"}</p>
            <button type="button" className="lobby-retry" onClick={retry}>重试</button>
          </div>
        ) : null}

        {coarse && ready && !active ? (
          <div className="lobby-dpad" aria-label="移动方向垫">
            <button type="button" className="lobby-dpad-btn lobby-dpad-up" aria-label="上" onPointerDown={press(0, -1)} onPointerUp={release} onPointerCancel={release}>▲</button>
            <button type="button" className="lobby-dpad-btn lobby-dpad-left" aria-label="左" onPointerDown={press(-1, 0)} onPointerUp={release} onPointerCancel={release}>◀</button>
            <button type="button" className="lobby-dpad-btn lobby-dpad-right" aria-label="右" onPointerDown={press(1, 0)} onPointerUp={release} onPointerCancel={release}>▶</button>
            <button type="button" className="lobby-dpad-btn lobby-dpad-down" aria-label="下" onPointerDown={press(0, 1)} onPointerUp={release} onPointerCancel={release}>▼</button>
          </div>
        ) : null}
      </div>

      <p className="lobby-credit">场景素材 Modern Interiors by <a href="https://limezu.itch.io/moderninteriors" target="_blank" rel="noreferrer">LimeZu</a></p>

      {active ? <MachineDialog machine={active} onClose={closeMachine} /> : null}
    </div>
  );
}
