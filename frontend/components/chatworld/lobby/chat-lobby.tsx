"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fetchLobbyProfile, type LobbyProfile } from "../../../lib/chat-lobby";
import { AvatarDialog } from "./avatar-dialog";
import { composeAvatarSheet, loadAvatarParts, normalizeAvatar } from "./game/avatar";
import type { LobbyBridge, LobbyEvents, MachineInfo, RoomInfo } from "./game/layout";
import { MachineDialog } from "./machine-dialog";

const LobbyCanvas = dynamic(() => import("./lobby-canvas"), {
  ssr: false,
  loading: () => <div className="lobby-canvas-host" />,
});

type Phase = "loading" | "ready" | "error";

/** 每个房间的一句话引导 */
const ROOM_GUIDES: Record<string, string> = {
  foyer: "入口厅 · 下方出口通往大厅，HannisHub 标牌下的电梯通往我的房间",
  room: "我的房间 · 站到衣柜前的地台上按 E 换形象、改名字，下方出口回入口厅",
  hall: "大厅 · ASR / OCR 机器前的地台、圆桌地毯上按 E 使用",
};

/** 在「我的房间」衣柜前交互时打开形象面板，其余机器打开功能面板 */
const AVATAR_MACHINE = "wardrobe";

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
const bridge: LobbyBridge = {
  touch: { x: 0, y: 0 },
  avatar: { sheet: null, version: 0 },
  paused: false,
  interactQueued: false,
};

/** 把资料中的形象合成为帧表写入桥接对象；无自定义形象或素材加载失败时使用默认角色 */
async function applyProfileAvatar(profile: LobbyProfile | null) {
  let sheet: HTMLCanvasElement | null = null;
  if (profile?.avatar) {
    try {
      const parts = await loadAvatarParts();
      sheet = composeAvatarSheet(parts, normalizeAvatar(parts, profile.avatar));
    } catch {
      sheet = null;
    }
  }
  bridge.avatar = { sheet, version: bridge.avatar.version + 1 };
}

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
  // 资料（名字与形象）就绪后才创建游戏，避免先显示默认角色再闪换
  const [profile, setProfile] = useState<LobbyProfile | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  // 重试时递增，LobbyCanvas 据此重建游戏
  const [gameKey, setGameKey] = useState(0);
  const coarse = useSyncExternalStore(subscribeCoarse, coarseSnapshot, coarseServerSnapshot);

  // 离开页面时面板可能仍处于打开状态，重新进入时复位共享状态
  useEffect(() => {
    resetBridge();
    return resetBridge;
  }, []);

  useEffect(() => {
    let alive = true;
    fetchLobbyProfile()
      .catch(() => null)
      .then(async loaded => {
        await applyProfileAvatar(loaded);
        if (!alive) return;
        setProfile(loaded);
        setProfileReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const saveProfile = useCallback((saved: LobbyProfile) => {
    setProfile(saved);
    void applyProfileAvatar(saved);
    bridge.paused = false;
    setActive(null);
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
        {profileReady ? <LobbyCanvas key={gameKey} bridge={bridge} events={events} /> : <div className="lobby-canvas-host" />}

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

      {active && active.id === AVATAR_MACHINE ? (
        <AvatarDialog
          profile={profile ?? { username: "", name: "", avatar: null, updated_at: null }}
          onClose={closeMachine}
          onSaved={saveProfile}
        />
      ) : null}
      {active && active.id !== AVATAR_MACHINE ? <MachineDialog machine={active} onClose={closeMachine} /> : null}
    </div>
  );
}
