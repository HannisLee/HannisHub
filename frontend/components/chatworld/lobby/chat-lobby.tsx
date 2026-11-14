"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  claimLobbyDesk, fetchLobbyDesks, fetchLobbyProfile, QUICK_EMOTES, releaseLobbyDesk, type LobbyDeskState, type LobbyProfile,
} from "../../../lib/chat-lobby";
import { errorMessage } from "../../../lib/format";
import { useShell } from "../../layout/shell-context";
import { AvatarDialog } from "./avatar-dialog";
import { DeskClaimDialog } from "./desk-claim-dialog";
import { composeAvatarSheet, loadAvatarParts, normalizeAvatar } from "./game/avatar";
import type { LobbyBridge, LobbyEvents, MachineInfo, NearbyInfo, RoomInfo } from "./game/layout";
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
  hall: "大厅 · 机器前、工位椅后、沙发与各处小物件旁按 E 互动，数字键 1–4 发表情",
};

/** 工位待办面板（在自己的工位坐下时打开） */
const TODO_MACHINE: MachineInfo = { id: "todo", title: "工位待办", hint: "今天要做的事，只有自己看得到" };

/** 快捷表情按钮的文字（与数字键 1–4 对应） */
const QUICK_EMOTE_LABELS: Record<(typeof QUICK_EMOTES)[number], string> = {
  wave: "嗨", laugh: "哈哈", like: "赞", think: "嗯",
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
  start: null,
  desks: { claims: {}, version: 0 },
  emoteQueued: "",
};

function applyDesks(state: LobbyDeskState) {
  bridge.desks = { claims: state.desks, version: bridge.desks.version + 1 };
}

/** 整页模式（普通账号）从我的房间出生 */
const PRIVATE_START = { room: "room", spawn: "fromFoyer" };

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
  bridge.emoteQueued = "";
}

export function ChatLobby() {
  const shell = useShell();
  const immersive = shell?.immersive ?? false;
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [nearby, setNearby] = useState<NearbyInfo | null>(null);
  const [active, setActive] = useState<MachineInfo | null>(null);
  const [desks, setDesks] = useState<LobbyDeskState>({ desks: {}, mine: null });
  // 正在询问是否认领的工位
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState("");
  const [toast, setToast] = useState("");
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

  // 出生点在游戏创建前写入（游戏要等资料加载完成才创建）
  useEffect(() => {
    bridge.start = immersive ? PRIVATE_START : null;
  }, [immersive]);

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

  const loadDesks = useCallback(() => {
    fetchLobbyDesks()
      .then(state => {
        applyDesks(state);
        setDesks(state);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadDesks();
  }, [loadDesks]);

  // 短暂提示（认领成功、工位被占用等）
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

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

  /** 在工位坐下：自己的工位打开待办，空闲工位询问是否认领，别人的工位只坐一会儿 */
  const sitAtDesk = useCallback((deskId: string) => {
    const claim = bridge.desks.claims[deskId];
    if (claim?.mine) {
      openMachine(TODO_MACHINE);
    } else if (!claim) {
      bridge.paused = true;
      setClaimError("");
      setClaiming(deskId);
    }
  }, [openMachine]);

  const confirmClaim = useCallback(async () => {
    if (!claiming) return;
    try {
      const state = await claimLobbyDesk(claiming);
      applyDesks(state);
      setDesks(state);
      setClaiming(null);
      setToast("工位已认领，挂上了你的名牌");
      openMachine(TODO_MACHINE);
    } catch (value) {
      setClaimError(errorMessage(value));
      loadDesks();
    }
  }, [claiming, loadDesks, openMachine]);

  const cancelClaim = useCallback(() => {
    bridge.paused = false;
    setClaiming(null);
  }, []);

  const releaseDesk = useCallback(async () => {
    if (!window.confirm("退还工位后名牌会摘下，待办清单不受影响。确定退还吗？")) return;
    try {
      const state = await releaseLobbyDesk();
      applyDesks(state);
      setDesks(state);
      closeMachine();
      setToast("工位已退还");
    } catch (value) {
      setToast(errorMessage(value));
    }
  }, [closeMachine]);

  const sendEmote = useCallback((key: string) => {
    bridge.emoteQueued = key;
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
    onDesk: sitAtDesk,
    onDesksChanged: loadDesks,
  }), [openMachine, sitAtDesk, loadDesks]);

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
    <div className={`lobby${immersive ? " is-immersive" : ""}`}>
      {immersive ? null : <header className="lobby-head">
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
          <span className="lobby-hint-group">
            <span className="lobby-hint-keys"><Key>1</Key><Key>4</Key></span>
            <span className="lobby-hint-text">表情</span>
          </span>
        </div>
      </header>}

      <div className="lobby-stage">
        {profileReady ? <LobbyCanvas key={gameKey} bridge={bridge} events={events} /> : <div className="lobby-canvas-host" />}

        {ready && room ? (
          <div className="lobby-room-chip" aria-live="polite">
            <span className="lobby-dot" aria-hidden="true" />
            {room.name}
          </div>
        ) : null}

        {immersive && shell ? (
          <div className="lobby-account">
            <span className="lobby-account-name">{profile?.name || shell.username}</span>
            <button type="button" className="lobby-account-logout" onClick={() => void shell.logout()}>退出</button>
          </div>
        ) : null}

        {ready && nearby && !active && !claiming ? (
          <div className="lobby-prompt" role="status">
            <Key>E</Key>
            <span className="lobby-prompt-text">
              {nearby.kind === "machine" ? "使用 " : null}<strong>{nearby.title}</strong>
              <span className="lobby-prompt-hint">{nearby.hint}</span>
            </span>
            {coarse ? (
              <button type="button" className="lobby-prompt-button" onClick={() => { bridge.interactQueued = true; }}>
                {nearby.kind === "machine" ? "使用" : nearby.id === "stand" ? "起身" : "互动"}
              </button>
            ) : null}
          </div>
        ) : null}

        {ready && !active && !claiming ? (
          <div className="lobby-emotes" aria-label="快捷表情">
            {QUICK_EMOTES.map((key, i) => (
              <button key={key} type="button" className="lobby-emote" onClick={() => sendEmote(key)} title={`快捷表情（数字键 ${i + 1}）`}>
                {coarse ? null : <kbd>{i + 1}</kbd>}{QUICK_EMOTE_LABELS[key]}
              </button>
            ))}
          </div>
        ) : null}

        {toast ? <div className="lobby-toast" role="status">{toast}</div> : null}

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

      <p className={`lobby-credit${immersive ? " is-overlay" : ""}`}>场景素材 Modern Interiors by <a href="https://limezu.itch.io/moderninteriors" target="_blank" rel="noreferrer">LimeZu</a></p>

      {active && active.id === AVATAR_MACHINE ? (
        <AvatarDialog
          profile={profile ?? { username: "", name: "", avatar: null, updated_at: null }}
          onClose={closeMachine}
          onSaved={saveProfile}
        />
      ) : null}
      {active && active.id !== AVATAR_MACHINE ? (
        <MachineDialog
          machine={active}
          onClose={closeMachine}
          actions={active.id === TODO_MACHINE.id && desks.mine ? (
            <button type="button" className="lobby-machine-link" onClick={() => void releaseDesk()}>退还工位</button>
          ) : null}
        />
      ) : null}
      {claiming ? (
        <DeskClaimDialog
          hasDesk={Boolean(desks.mine)}
          error={claimError}
          onConfirm={() => void confirmClaim()}
          onCancel={cancelClaim}
        />
      ) : null}
    </div>
  );
}
