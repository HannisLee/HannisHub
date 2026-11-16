"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { onPool, sendPool, setActivePoolTable, type PoolGame, type PoolGroup, type PoolSeat, type PoolTableView } from "../../../lib/lobby-pool";
import type { MachineInfo } from "../lobby/game/layout";
import { PoolEngine, type EngineUi } from "./engine";
import { ballCss } from "./render";
import { GROUP_LABEL, otherSeat } from "./rules";
import { poolSounds } from "./sounds";

const SEATS: PoolSeat[] = ["left", "right"];
const GROUP_BALLS: Record<PoolGroup, number[]> = { solid: [1, 2, 3, 4, 5, 6, 7], stripe: [9, 10, 11, 12, 13, 14, 15] };

/** 卸载时延迟离座：开发模式下 React 会立即重新挂载，取消这次离座，避免误判负 */
let pendingLeave: ReturnType<typeof setTimeout> | null = null;

function seatOfMachine(id: string): PoolSeat | null {
  if (id === "pool-left") return "left";
  if (id === "pool-right") return "right";
  return null;
}

function MiniBall({ n, gone }: { n: number; gone?: boolean }) {
  const stripe = n > 8;
  return (
    <span
      className={`pool-mini${stripe ? " is-stripe" : ""}${gone ? " is-gone" : ""}`}
      style={{ ["--ball" as string]: ballCss(n) }}
      title={n === 0 ? "白球" : `${n} 号球${gone ? "（已进袋）" : ""}`}
    >
      {n === 0 ? "白" : n}
    </span>
  );
}

function PlayerCard({ table, game, seat, ui }: { table: PoolTableView | null; game: PoolGame | null; seat: PoolSeat; ui: EngineUi }) {
  const occupant = table?.seats[seat] ?? null;
  const group = game?.groups[seat] ?? null;
  const onTable = new Set((game?.balls ?? []).map(b => b[0]));
  const notStarted = !game?.balls;
  const active = Boolean(game && table?.status === "playing" && game.turn === seat);
  const mine = Boolean(table?.you.includes(seat));
  const name = occupant ? (table?.solo ? `${occupant.name} · ${seat === "left" ? "1P" : "2P"}` : occupant.name) : "空位";
  const remaining = group ? GROUP_BALLS[group].filter(n => notStarted || onTable.has(n)).length : 0;
  return (
    <div className={`pool-player${active ? " is-turn" : ""}${occupant ? "" : " is-empty"}`}>
      <div className="pool-player-head">
        <span className="pool-player-side">{seat === "left" ? "左侧" : "右侧"}</span>
        <span className="pool-player-name">{name}</span>
        {mine && !table?.solo ? <span className="pool-tag">你</span> : null}
        {active ? <span className="pool-turn">{ui.animating ? "击球中" : "击球"}</span> : null}
        {game?.winner === seat ? <span className="pool-tag is-win">胜</span> : null}
      </div>
      <div className="pool-player-balls">
        {group ? (
          <>
            {GROUP_BALLS[group].map(n => <MiniBall key={n} n={n} gone={!notStarted && !onTable.has(n)} />)}
            <MiniBall n={8} gone={!notStarted && !onTable.has(8)} />
            <span className="pool-player-note">{remaining ? `${GROUP_LABEL[group]} · 剩 ${remaining}` : "目标：黑 8"}</span>
          </>
        ) : (
          <span className="pool-player-note">{game ? "未分花色（开放球局）" : occupant ? "已入座" : "走到球桌这一端按 E 入座"}</span>
        )}
      </div>
    </div>
  );
}

/** 击球点选择：白球正面，点击设置高低杆与左右塞 */
function SpinPicker({ ui, onChange }: { ui: EngineUi; onChange: (x: number, y: number) => void }) {
  const set = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.type === "pointermove" && event.buttons === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    const k = Math.hypot(x, y) > 0.92 ? 0.92 / Math.hypot(x, y) : 1;
    onChange((x * k) / 0.92, (y * k) / 0.92);
  };
  const label = ui.spinY > 0.25 ? "高杆" : ui.spinY < -0.25 ? "低杆" : "中杆";
  const side = ui.spinX > 0.25 ? " · 右塞" : ui.spinX < -0.25 ? " · 左塞" : "";
  return (
    <div className="pool-spin">
      <button
        type="button"
        className="pool-spin-ball"
        aria-label="击球点：点击白球上的位置设置高低杆和左右塞，双击复位"
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          set(event);
        }}
        onPointerMove={set}
        onDoubleClick={() => onChange(0, 0)}
      >
        <span className="pool-spin-dot" style={{ left: `${50 + ui.spinX * 46}%`, top: `${50 - ui.spinY * 46}%` }} />
      </button>
      <span className="pool-control-label">{label}{side}</span>
    </div>
  );
}

/** 力度条：按住向下（窄屏向右）拖动蓄力，松开击球 */
function PowerBar({ engine, ui }: { engine: PoolEngine | null; ui: EngineUi }) {
  const value = engine?.pullPower ?? null;
  const measure = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const vertical = rect.height > rect.width;
    const k = vertical ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, k));
  };
  // 未拖动时显示方向键设定的力度（空格击球使用）
  const shown = value ?? ui.power;
  return (
    <div className="pool-power">
      <div
        className={`pool-power-bar${ui.canShoot ? "" : " is-disabled"}`}
        role="slider"
        aria-label="击球力度：按住拖动蓄力，松开击球"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        tabIndex={-1}
        onPointerDown={event => {
          if (!ui.canShoot) return;
          poolSounds().unlock();
          event.currentTarget.setPointerCapture(event.pointerId);
          engine?.setBarPull(measure(event));
        }}
        onPointerMove={event => {
          if (event.buttons === 0 || engine?.pullPower === null) return;
          engine?.setBarPull(measure(event));
        }}
        onPointerUp={() => engine?.setBarPull(null, true)}
        onPointerCancel={() => engine?.setBarPull(null, false)}
      >
        <span className={`pool-power-fill${value === null ? " is-preset" : ""}`} style={{ ["--power" as string]: `${shown * 100}%` }} />
      </div>
      <span className="pool-control-label">{`力度 ${Math.round(shown * 100)}%`}</span>
    </div>
  );
}

const EMPTY_UI: EngineUi = { canShoot: false, animating: false, power: 0.35, spinX: 0, spinY: 0, hand: false, aimLocked: false, game: null };

/** 台球桌面板：中式八球，双人对战或单人练习；在大厅台球桌两端按 E 入座，正面按 E 观战 */
export function PoolPanel({ machine }: { machine: MachineInfo; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<PoolEngine | null>(null);
  const [table, setTable] = useState<PoolTableView | null>(null);
  const [ui, setUi] = useState<EngineUi>(EMPTY_UI);
  const [muted, setMuted] = useState(() => poolSounds().muted);
  const [connected, setConnected] = useState(true);
  const requested = seatOfMachine(machine.id);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    if (pendingLeave) {
      clearTimeout(pendingLeave);
      pendingLeave = null;
    }
    let frame = 0;
    const instance = new PoolEngine(canvas, host, () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setUi(instance.ui());
      });
    });
    setEngine(instance);
    // 对话框默认聚焦关闭按钮：改为聚焦球台，避免空格击球时误触按钮
    canvas.focus({ preventScroll: true });
    const subscribe = () => {
      const ok = sendPool({ op: "watch" });
      if (ok && requested) sendPool({ op: "sit", seat: requested });
      setConnected(ok);
      return ok;
    };
    // 同步通道可能还在连接中：未就绪时稍后重试
    let retry: ReturnType<typeof setInterval> | null = subscribe() ? null : setInterval(() => {
      if (subscribe() && retry) {
        clearInterval(retry);
        retry = null;
      }
    }, 1000);
    const off = onPool(message => {
      if (message.ev === "table") {
        setActivePoolTable(message.table);
        instance.setTable(message.table);
        setTable(message.table);
        setConnected(true);
      } else if (message.ev === "shot") {
        instance.receiveShot(message.shot, message.game, message.version);
      } else if (message.ev === "aim") {
        instance.receiveAim(message.a, message.p, message.x, message.y);
      } else if (message.ev === "reconnect") {
        sendPool({ op: "watch" });
      }
    });
    return () => {
      off();
      if (retry) clearInterval(retry);
      if (frame) cancelAnimationFrame(frame);
      instance.destroy();
      setActivePoolTable(null);
      pendingLeave = setTimeout(() => {
        pendingLeave = null;
        sendPool({ op: "leave" });
        sendPool({ op: "unwatch" });
      }, 0);
    };
  }, [requested]);

  // 键盘：←→ 微调方向（按住 Shift 更细），↑↓ 调整力度，空格击球
  useEffect(() => {
    if (!engine) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const fine = event.shiftKey ? 0.1 : 1;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        engine.rotate(((event.key === "ArrowLeft" ? -1 : 1) * fine * Math.PI) / 360);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        engine.setPower(engine.power + (event.key === "ArrowUp" ? 0.05 : -0.05));
      } else if (event.key === " " && !event.repeat) {
        event.preventDefault();
        engine.shoot();
      }
    };
    // 按钮在空格松开时才触发点击：拦截松开，避免击球的同时点到聚焦的按钮
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " " && (event.target as HTMLElement | null)?.tagName === "BUTTON") event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [engine]);

  const toggleMute = useCallback(() => {
    const next = !poolSounds().muted;
    poolSounds().setMuted(next);
    setMuted(next);
  }, []);

  // 显示以引擎为准：回放进行中仍是击球前的状态，回放结束才切换到新状态
  const game = ui.game ?? null;
  const you = table?.you ?? [];
  const seated = you.length > 0;
  const status = table?.status ?? "open";
  const turnName = game && table?.seats[game.turn] ? table.seats[game.turn]!.name : "";
  const myTurn = ui.canShoot;

  let line = "";
  if (!connected) line = "正在连接大厅同步通道…";
  else if (!table) line = "正在读取球桌…";
  else if (status === "open") line = seated ? "等待对手入座：另一位玩家走到球桌另一端按 E 即可开局" : "球桌空闲";
  else if (status === "over") line = game?.msg ?? "本局结束";
  else if (ui.animating) line = game?.msg ? `${turnName} 击球中…` : "击球中…";
  else if (game) {
    const who = table.solo ? (game.turn === "left" ? "1P" : "2P") : myTurn ? "你" : turnName;
    const prefix = game.msg ? `${game.msg} · ` : "";
    const hand = game.hand ? (game.kitchen ? "（开球区自由球）" : "（自由球）") : "";
    line = `${prefix}轮到 ${who}${hand}`;
  }

  const help = ui.hand
    ? "拖动白球摆放自由球 · 鼠标瞄准，按住向后拖动蓄力，松开击球"
    : "鼠标瞄准，按住向后拖动蓄力、松开击球；单击锁定方向，←→ 微调（Shift 更细），也可拖动右侧力度条";

  const rematchAsked = game && table ? you.some(s => table.rematch.includes(s)) : false;
  const showOver = status === "over" && !ui.animating && game;
  const winnerName = game?.winner && table?.seats[game.winner] ? table.seats[game.winner]!.name : "";

  return (
    <div className="pool">
      <div className="pool-players">
        <PlayerCard table={table} game={game} seat="left" ui={ui} />
        <div className="pool-status" aria-live="polite">{line}</div>
        <PlayerCard table={table} game={game} seat="right" ui={ui} />
      </div>

      <div className="pool-stage">
        <div ref={hostRef} className="pool-table">
          <canvas ref={canvasRef} tabIndex={0} className={`pool-canvas${myTurn ? " is-active" : ""}`} aria-label="台球桌" />
          {table && status === "open" ? (
            <div className="pool-overlay">
              <p className="pool-overlay-title">中式八球</p>
              <p className="pool-overlay-text">
                {seated ? "已入座，等待对手。也可以一个人打两边练习。" : "两人分别站到球桌两端按 E 入座即可开局，也可以单人练习。"}
              </p>
              <div className="pool-overlay-actions">
                <button type="button" className="pool-button is-primary" onClick={() => sendPool({ op: "solo" })}>单人练习（自己对打）</button>
                {SEATS.filter(s => !table.seats[s]).map(s => (
                  <button key={s} type="button" className="pool-button" onClick={() => sendPool({ op: "sit", seat: s })}>
                    {seated ? `换到${s === "left" ? "左侧" : "右侧"}` : `坐${s === "left" ? "左侧" : "右侧"}`}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {showOver ? (
            <div className="pool-overlay">
              <p className="pool-overlay-title">{table?.solo ? `${game.winner === "left" ? "1P" : "2P"} 获胜` : `${winnerName} 获胜`}</p>
              <p className="pool-overlay-text">{game.msg}</p>
              {seated ? (
                <div className="pool-overlay-actions">
                  <button type="button" className="pool-button is-primary" disabled={Boolean(rematchAsked && !table?.solo)} onClick={() => sendPool({ op: "rematch" })}>
                    {rematchAsked && !table?.solo ? "等待对方确认…" : "再来一局"}
                  </button>
                  {table?.solo ? null : (
                    <span className="pool-overlay-note">
                      {table && game.winner && table.rematch.includes(otherSeat(you[0] ?? "left")) ? "对方想再来一局" : ""}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="pool-controls">
          <SpinPicker ui={ui} onChange={(x, y) => engine?.setSpin(x, y)} />
          <PowerBar engine={engine} ui={ui} />
          <button type="button" className="pool-mute" onClick={toggleMute} aria-pressed={muted} title={muted ? "开启音效" : "关闭音效"}>
            {muted ? "静音" : "音效"}
          </button>
        </div>
      </div>

      <div className="pool-foot">
        <span className="pool-help">{myTurn ? help : seated ? (status === "playing" ? "等待对方击球" : "") : "观战中 · 球桌两端按 E 可入座"}</span>
        <span className="pool-rules" title="中式八球：开球后第一颗合法进袋的球决定花色；清完己方 7 颗球后打进黑 8 获胜；犯规后对方获得自由球；提前打进黑 8 或进黑 8 时犯规判负。">
          规则说明
        </span>
        {seated && status === "playing" && !table?.solo ? <span className="pool-help">离开球桌会判负</span> : null}
        {game?.last?.pocketed?.length ? (
          <span className="pool-last">
            上一杆进袋
            {game.last.pocketed.map((n, i) => <MiniBall key={`${n}-${i}`} n={n} />)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
