/** 台球面板的游戏引擎：持有画布、显示状态、回放队列与输入，React 面板只负责外围界面。
 *
 *  同步方式：
 *  - 自己击球：本地立即模拟整杆并判定规则，把「击球参数 + 新对局状态」发给服务端，同时开始本地回放
 *  - 别人击球：收到参数后从当前显示的对局状态出发做同样的模拟回放，结束后切换到对方上传的对局状态
 *  - 球桌快照（table）版本号与已应用的不一致时直接对齐（重连、被服务端拒绝等情况） */

import {
  sendPool, type PoolGame, type PoolSeat, type PoolShot, type PoolTableView,
} from "../../../lib/lobby-pool";
import { makeShot, simulate, type SimBall, type SimEvent, type SimResult } from "./physics";
import { drawCue, drawNumber, drawTable, paintBall, randomOrientation, roll, VIEW, type Mat3 } from "./render";
import { gameBalls, groupOf, judge, targetOf, validCueSpot } from "./rules";
import { poolSounds } from "./sounds";
import { HEAD_X, L, POCKETS, R, W, round1 } from "./table";

interface BallView {
  n: number;
  x: number;
  y: number;
  m: Mat3;
  sprite: HTMLCanvasElement;
  dirty: boolean;
  spriteSize: number;
}

interface Playback {
  result: SimResult;
  next: PoolGame;
  version: number;
  start: number;
  eventIndex: number;
  frame: number;
}

interface Sinking {
  n: number;
  x: number;
  y: number;
  px: number;
  py: number;
  view: BallView;
  start: number;
}

const AIM_SEND_MS = 90;
const SINK_MS = 240;
/** 鼠标向后拖动多少毫米（台面坐标）为满力 */
const PULL_FULL = 700;

export interface EngineUi {
  /** 是否轮到本端操作（可以瞄准、击球） */
  canShoot: boolean;
  animating: boolean;
  power: number;
  spinX: number;
  spinY: number;
  /** 正在摆放自由球 */
  hand: boolean;
  aimLocked: boolean;
  /** 画面上正在显示的对局状态（回放结束前仍是击球前的状态） */
  game: PoolGame | null;
}

export class PoolEngine {
  table: PoolTableView | null = null;
  game: PoolGame | null = null;
  private applied = -1;
  private balls = new Map<number, BallView>();
  private queue: { shot: PoolShot; game: PoolGame; version: number }[] = [];
  private playback: Playback | null = null;
  private sinking: Sinking[] = [];
  private pendingSnap: PoolTableView | null = null;

  angle = 0;
  power = 0.35;
  spinX = 0;
  spinY = 0;
  aimLocked = false;
  private cue: { x: number; y: number } | null = null;
  private pull: { x: number; y: number; power: number } | null = null;
  private placing = false;
  private touchAim = false;
  private pointerWorld: { x: number; y: number } | null = null;
  private remoteAim: { a: number; p: number; x: number | null; y: number | null; at: number } | null = null;
  private aimSentAt = 0;
  private aimKey = "";
  private aimTimer: ReturnType<typeof setTimeout> | null = null;

  private ctx: CanvasRenderingContext2D | null;
  private scale = 1;
  private rotated = false;
  private dpr = 1;
  private frameId = 0;
  private destroyed = false;
  private resize: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, private onUi: () => void) {
    this.ctx = canvas.getContext("2d");
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.frameId = requestAnimationFrame(this.tick);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frameId);
    this.resize.disconnect();
    if (this.aimTimer) clearTimeout(this.aimTimer);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
  }

  // ---------- 状态 ----------

  get busy(): boolean {
    return this.playback !== null || this.queue.length > 0;
  }

  /** 本端是否占着当前轮次的球位（单人练习时两边都是自己） */
  get myTurn(): boolean {
    const t = this.table;
    const g = this.game;
    return Boolean(t && g && t.status === "playing" && g.phase !== "over" && t.you.includes(g.turn));
  }

  get canShoot(): boolean {
    return this.myTurn && !this.busy;
  }

  ui(): EngineUi {
    return {
      canShoot: this.canShoot,
      animating: this.busy,
      power: this.power,
      spinX: this.spinX,
      spinY: this.spinY,
      hand: Boolean(this.canShoot && this.game?.hand),
      aimLocked: this.aimLocked,
      game: this.game,
    };
  }

  /** 台面上当前显示的球（白球按本端摆放位置） */
  private currentBalls(): SimBall[] {
    const list: SimBall[] = [];
    for (const b of this.balls.values()) list.push({ n: b.n, x: b.x, y: b.y });
    return list.sort((a, b) => a.n - b.n);
  }

  setTable(view: PoolTableView) {
    const previous = this.table;
    this.table = view;
    if (view.version !== this.applied && !this.queue.some(q => q.version === view.version)
      && !(this.playback && this.playback.version === view.version)) {
      if (this.playback) this.pendingSnap = view;
      else this.snap(view);
    }
    if (previous && previous.status !== "playing" && view.status === "playing" && view.you.length) poolSounds().play("start", 0.6);
    this.onUi();
  }

  private snap(view: PoolTableView) {
    const fresh = !this.game || !view.game || view.game.rack.join() !== this.game.rack.join() || !view.game.balls;
    this.queue = [];
    this.applyGame(view.game, view.version, fresh);
  }

  private applyGame(game: PoolGame | null, version: number, fresh: boolean) {
    const wasMine = this.myTurn;
    this.game = game;
    this.applied = version;
    this.cue = null;
    this.pull = null;
    this.placing = false;
    if (!game) {
      this.balls.clear();
    } else {
      const list = gameBalls(game);
      const keep = new Set(list.map(b => b.n));
      for (const n of [...this.balls.keys()]) if (!keep.has(n)) this.balls.delete(n);
      for (const b of list) {
        const view = this.balls.get(b.n);
        if (view && !fresh) {
          view.x = b.x;
          view.y = b.y;
        } else {
          this.balls.set(b.n, {
            n: b.n, x: b.x, y: b.y, m: randomOrientation(), sprite: document.createElement("canvas"), dirty: true, spriteSize: 0,
          });
        }
      }
    }
    if (this.myTurn) {
      this.aimLocked = false;
      this.aimAtTarget();
      if (!wasMine && !this.table?.solo) poolSounds().play("turn", 0.5);
    }
    this.remoteAim = null;
    this.onUi();
  }

  /** 轮到自己时默认瞄准最近的一颗目标球 */
  private aimAtTarget() {
    const game = this.game;
    const cue = this.balls.get(0);
    if (!game || !cue) return;
    const balls = this.currentBalls();
    const target = game.phase === "break" ? null : targetOf(game, game.turn, balls);
    let best: SimBall | null = null;
    let bestD = Infinity;
    for (const b of balls) {
      if (b.n === 0) continue;
      const ok = target === 8 ? b.n === 8 : target ? groupOf(b.n) === target : b.n !== 8;
      if (!ok) continue;
      const d = (b.x - cue.x) ** 2 + (b.y - cue.y) ** 2;
      if (game.phase === "break" ? b.x < (best?.x ?? Infinity) : d < bestD) {
        best = b;
        bestD = d;
      }
    }
    if (best) this.angle = Math.atan2(best.y - cue.y, best.x - cue.x);
  }

  receiveShot(shot: PoolShot, game: PoolGame, version: number) {
    if (version <= this.applied || this.queue.some(q => q.version >= version)) return;
    this.queue.push({ shot, game, version });
    this.remoteAim = null;
    if (!this.playback) this.nextPlayback();
    this.onUi();
  }

  receiveAim(a: number, p: number, x: number | null, y: number | null) {
    if (this.myTurn) return;
    this.remoteAim = { a, p, x, y, at: performance.now() };
  }

  private nextPlayback() {
    const item = this.queue.shift();
    if (!item) return;
    const balls = this.currentBalls().map(b => (b.n === 0 ? { n: 0, x: item.shot.cx, y: item.shot.cy } : b));
    const cue = this.balls.get(0);
    if (cue) {
      cue.x = item.shot.cx;
      cue.y = item.shot.cy;
    }
    this.startPlayback(simulate(balls, item.shot), item.game, item.version, item.shot);
  }

  private startPlayback(result: SimResult, next: PoolGame, version: number, shot: PoolShot) {
    this.playback = { result, next, version, start: performance.now(), eventIndex: 0, frame: 0 };
    const speed = Math.hypot(shot.vx, shot.vy);
    poolSounds().play("cue", 0.35 + Math.min(0.65, speed / 6000));
    this.onUi();
  }

  private finishPlayback() {
    const playback = this.playback;
    if (!playback) return;
    this.playback = null;
    const fresh = !playback.next.balls;
    this.applyGame(playback.next, playback.version, fresh);
    if (this.pendingSnap) {
      const view = this.pendingSnap;
      this.pendingSnap = null;
      if (view.version !== this.applied && !this.queue.some(q => q.version === view.version)) this.snap(view);
    }
    if (this.queue.length) this.nextPlayback();
    this.onUi();
  }

  // ---------- 操作 ----------

  setPower(power: number) {
    this.power = Math.max(0, Math.min(1, power));
    this.sendAim();
    this.onUi();
  }

  setSpin(x: number, y: number) {
    const len = Math.hypot(x, y);
    const k = len > 1 ? 1 / len : 1;
    this.spinX = x * k;
    this.spinY = y * k;
    this.onUi();
  }

  /** 力度条拖动中：球杆随之后拉；结束时 shoot 为 true 则以该力度击球 */
  setBarPull(power: number | null, shoot = false) {
    if (!this.canShoot) {
      this.pull = null;
      return;
    }
    if (power === null) {
      const value = this.pull?.power ?? 0;
      this.pull = null;
      if (shoot && value >= 0.02) this.shoot(value);
      this.onUi();
      return;
    }
    this.pull = { x: Number.NaN, y: Number.NaN, power: Math.max(0, Math.min(1, power)) };
    this.sendAim();
    this.onUi();
  }

  get pullPower(): number | null {
    return this.pull ? this.pull.power : null;
  }

  rotate(delta: number) {
    if (!this.canShoot) return;
    this.angle += delta;
    this.aimLocked = true;
    this.sendAim();
  }

  /** 击球：本地模拟与判定，上传结果并开始回放 */
  shoot(power = this.power) {
    const game = this.game;
    const table = this.table;
    const cueView = this.balls.get(0);
    if (!this.canShoot || !game || !table || !cueView || power < 0.02) return;
    poolSounds().unlock();
    const cue = this.cue ?? { x: cueView.x, y: cueView.y };
    const start = this.currentBalls().map(b => (b.n === 0 ? { n: 0, x: round1(cue.x), y: round1(cue.y) } : b));
    const input = makeShot(Math.cos(this.angle), Math.sin(this.angle), power, this.spinX, this.spinY);
    const shot: PoolShot = { ...input, cx: round1(cue.x), cy: round1(cue.y) };
    const result = simulate(start, input);
    const next = judge(game, start, result);
    if (!sendPool({ op: "shot", shot, game: next })) return;
    const version = table.version + 1;
    this.table = { ...table, version };
    cueView.x = shot.cx;
    cueView.y = shot.cy;
    this.cue = null;
    this.pull = null;
    this.power = power;
    this.startPlayback(result, next, version, shot);
  }

  /** 节流发送瞄准状态，让对手和观众看到球杆 */
  private sendAim() {
    if (!this.canShoot) return;
    const now = performance.now();
    const cue = this.game?.hand ? this.cue : null;
    const key = `${this.angle.toFixed(3)}|${this.power.toFixed(2)}|${cue ? `${Math.round(cue.x)},${Math.round(cue.y)}` : ""}`;
    if (key === this.aimKey) return;
    const wait = AIM_SEND_MS - (now - this.aimSentAt);
    if (wait > 0) {
      if (!this.aimTimer) this.aimTimer = setTimeout(() => {
        this.aimTimer = null;
        this.sendAim();
      }, wait);
      return;
    }
    this.aimKey = key;
    this.aimSentAt = now;
    const shownPower = this.pull ? this.pull.power : 0;
    sendPool({ op: "aim", a: Math.round(this.angle * 10000) / 10000, p: Math.round(shownPower * 1000) / 1000, ...(cue ? { x: round1(cue.x), y: round1(cue.y) } : {}) });
  }

  // ---------- 输入 ----------

  private toWorld(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (event.clientX - rect.left) / this.scale;
    const sy = (event.clientY - rect.top) / this.scale;
    // 竖屏时球台顺时针旋转 90°：屏幕 x 对应台面 y（反向），屏幕 y 对应台面 x
    if (this.rotated) return { x: sy + VIEW.x, y: VIEW.h + VIEW.y - sx };
    return { x: sx + VIEW.x, y: sy + VIEW.y };
  }

  private cuePosition() {
    const view = this.balls.get(0);
    return this.cue ?? (view ? { x: view.x, y: view.y } : null);
  }

  private aimAt(point: { x: number; y: number }) {
    const cue = this.cuePosition();
    if (!cue) return;
    const dx = point.x - cue.x;
    const dy = point.y - cue.y;
    if (dx * dx + dy * dy < R * R) return;
    this.angle = Math.atan2(dy, dx);
    this.sendAim();
  }

  private onPointerDown = (event: PointerEvent) => {
    poolSounds().unlock();
    if (!this.canShoot) return;
    const point = this.toWorld(event);
    const cue = this.cuePosition();
    this.canvas.setPointerCapture(event.pointerId);
    if (this.game?.hand && cue && Math.hypot(point.x - cue.x, point.y - cue.y) < R * 2.2) {
      this.placing = true;
      this.cue = { ...cue };
      return;
    }
    if (event.pointerType === "mouse") {
      if (event.button !== 0) return;
      this.pull = { x: point.x, y: point.y, power: 0 };
    } else {
      this.touchAim = true;
      this.aimAt(point);
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    const point = this.toWorld(event);
    this.pointerWorld = point;
    if (!this.canShoot) return;
    if (this.placing) {
      const kitchen = Boolean(this.game?.kitchen);
      const x = Math.max(R, Math.min((kitchen ? HEAD_X : L) - (kitchen ? 0 : R), point.x));
      const y = Math.max(R, Math.min(W - R, point.y));
      if (validCueSpot(x, y, this.currentBalls(), kitchen)) {
        this.cue = { x, y };
        const view = this.balls.get(0);
        if (view) {
          view.x = x;
          view.y = y;
        }
        this.sendAim();
      }
      return;
    }
    if (this.pull && !Number.isNaN(this.pull.x)) {
      const dx = Math.cos(this.angle);
      const dy = Math.sin(this.angle);
      const back = -((point.x - this.pull.x) * dx + (point.y - this.pull.y) * dy);
      this.pull.power = Math.max(0, Math.min(1, back / PULL_FULL));
      this.sendAim();
      this.onUi();
      return;
    }
    if (this.touchAim || (event.pointerType === "mouse" && !this.aimLocked)) this.aimAt(point);
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (this.placing) {
      this.placing = false;
      return;
    }
    this.touchAim = false;
    const pull = this.pull;
    this.pull = null;
    if (!pull || event.type === "pointercancel") return;
    if (pull.power >= 0.02) {
      this.shoot(pull.power);
    } else {
      // 没有拖动：单击切换「锁定瞄准」，锁定后移动鼠标不再改变方向（可用方向键微调）
      if (this.aimLocked) {
        this.aimLocked = false;
        this.aimAt(this.toWorld(event));
      } else {
        this.aimLocked = true;
      }
      this.onUi();
    }
  };

  private onPointerLeave = () => {
    this.pointerWorld = null;
  };

  // ---------- 绘制 ----------

  private fit() {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    // 竖长的空间（手机竖屏）把球台竖过来，画面能大一倍
    const flat = Math.min(width / VIEW.w, height / VIEW.h);
    const upright = Math.min(width / VIEW.h, height / VIEW.w);
    this.rotated = upright > flat * 1.15;
    this.scale = this.rotated ? upright : flat;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const cssW = Math.floor((this.rotated ? VIEW.h : VIEW.w) * this.scale);
    const cssH = Math.floor((this.rotated ? VIEW.w : VIEW.h) * this.scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
    for (const b of this.balls.values()) b.dirty = true;
  }

  private tick = (now: number) => {
    if (this.destroyed) return;
    this.frameId = requestAnimationFrame(this.tick);
    this.advance(now);
    this.draw(now);
  };

  /** 回放：按时间取帧（帧间插值），触发音效，球按位移滚动 */
  private advance(now: number) {
    const playback = this.playback;
    if (!playback) return;
    const { result } = playback;
    const elapsed = (now - playback.start) / 1000;
    const exact = elapsed * 60;
    const last = result.frames.length - 1;
    if (exact >= last) {
      this.moveTo(result.frames[last], result.frames[last], 0, now, result.events);
      this.playEvents(playback, Infinity);
      this.finishPlayback();
      return;
    }
    const i = Math.floor(exact);
    this.moveTo(result.frames[i], result.frames[i + 1], exact - i, now, result.events);
    this.playEvents(playback, elapsed);
  }

  private moveTo(a: Float32Array, b: Float32Array, k: number, now: number, events: SimEvent[]) {
    for (const ball of [...this.balls.values()]) {
      const ax = a[ball.n * 2];
      const ay = a[ball.n * 2 + 1];
      if (Number.isNaN(ax)) {
        // 已落袋：滑向袋口并缩小消失
        const event = events.find(e => e.kind === "pocket" && e.ball === ball.n);
        const pocket = POCKETS[event && event.kind === "pocket" ? event.pocket : 0];
        this.sinking.push({ n: ball.n, x: ball.x, y: ball.y, px: pocket.hx, py: pocket.hy, view: ball, start: now });
        this.balls.delete(ball.n);
        continue;
      }
      const bx = b[ball.n * 2];
      const by = b[ball.n * 2 + 1];
      const x = Number.isNaN(bx) ? ax : ax + (bx - ax) * k;
      const y = Number.isNaN(by) ? ay : ay + (by - ay) * k;
      const dx = x - ball.x;
      const dy = y - ball.y;
      if (dx !== 0 || dy !== 0) {
        ball.m = roll(ball.m, dx, dy);
        ball.dirty = true;
        ball.x = x;
        ball.y = y;
      }
    }
  }

  private playEvents(playback: Playback, until: number) {
    const sounds = poolSounds();
    const events = playback.result.events;
    let budget = 6;
    while (playback.eventIndex < events.length && events[playback.eventIndex].t <= until) {
      const e = events[playback.eventIndex++];
      if (budget-- <= 0) continue;
      if (e.kind === "hit") sounds.play("hit", Math.min(1, e.speed / 2500));
      else if (e.kind === "rail") sounds.play("rail", Math.min(0.8, e.speed / 3000));
      else sounds.play("pocket", 0.8);
    }
  }

  private draw(now: number) {
    const ctx = this.ctx;
    if (!ctx || !this.canvas.width) return;
    const s = this.scale * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.rotated) ctx.setTransform(0, s, -s, 0, (VIEW.h + VIEW.y) * s, -VIEW.x * s);
    else ctx.setTransform(s, 0, 0, s, -VIEW.x * s, -VIEW.y * s);
    drawTable(ctx);

    const game = this.game;
    const aiming = this.canShoot;
    if (aiming && game?.hand && game.kitchen) {
      ctx.fillStyle = "rgba(250, 249, 245, 0.05)";
      ctx.fillRect(0, 0, HEAD_X, W);
    }

    // 落袋动画
    this.sinking = this.sinking.filter(item => now - item.start < SINK_MS);
    for (const item of this.sinking) {
      const k = (now - item.start) / SINK_MS;
      const x = item.x + (item.px - item.x) * Math.min(1, k * 1.4);
      const y = item.y + (item.py - item.y) * Math.min(1, k * 1.4);
      ctx.globalAlpha = 1 - k;
      this.drawBall(ctx, { ...item.view, x, y }, 1 - k * 0.45, s);
      ctx.globalAlpha = 1;
    }

    // 阴影
    ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
    for (const b of this.balls.values()) {
      ctx.beginPath();
      ctx.ellipse(b.x + R * 0.22, b.y + R * 0.28, R * 0.98, R * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const cue = this.balls.get(0);
    // 瞄准辅助线画在球的下面
    if (aiming && cue) this.drawGuide(ctx, cue.x, cue.y, Math.cos(this.angle), Math.sin(this.angle), 1);
    else if (!this.busy && cue && this.remoteAim && now - this.remoteAim.at < 4000 && this.table?.status === "playing") {
      const ra = this.remoteAim;
      if (ra.x !== null && ra.y !== null) {
        cue.x = ra.x;
        cue.y = ra.y;
      }
      this.drawGuide(ctx, cue.x, cue.y, Math.cos(ra.a), Math.sin(ra.a), 0.6);
    }

    for (const b of this.balls.values()) this.drawBall(ctx, b, 1, s);

    if (game?.hand && aiming && cue) {
      ctx.strokeStyle = this.placing ? "rgba(217, 119, 87, 0.95)" : "rgba(250, 249, 245, 0.55)";
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.arc(cue.x, cue.y, R * 1.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 球杆
    if (cue && aiming && !this.placing) {
      const back = R + 10 + (this.pull ? this.pull.power * 260 : 0);
      const dx = Math.cos(this.angle);
      const dy = Math.sin(this.angle);
      drawCue(ctx, cue.x - dx * back, cue.y - dy * back, dx, dy);
    } else if (cue && !this.busy && this.remoteAim && now - this.remoteAim.at < 4000 && this.table?.status === "playing") {
      const ra = this.remoteAim;
      const back = R + 10 + ra.p * 260;
      const dx = Math.cos(ra.a);
      const dy = Math.sin(ra.a);
      drawCue(ctx, cue.x - dx * back, cue.y - dy * back, dx, dy, 0.85);
    }
  }

  private drawBall(ctx: CanvasRenderingContext2D, b: BallView, scale: number, s: number) {
    const size = Math.max(8, Math.ceil(2 * R * s * scale) + 2);
    if (b.dirty || b.spriteSize !== size) {
      paintBall(b.sprite, b.n, b.m, size);
      b.dirty = false;
      b.spriteSize = size;
    }
    const half = size / 2 / s;
    ctx.drawImage(b.sprite, b.x - half, b.y - half, size / s, size / s);
    drawNumber(ctx, b.n, b.m, b.x, b.y, R * scale);
  }

  /** 瞄准线：白球路径、假想球、目标球去向与白球分离方向；先碰到的不是合法目标时用红色 */
  private drawGuide(ctx: CanvasRenderingContext2D, cx: number, cy: number, dx: number, dy: number, alpha: number) {
    let tBall = Infinity;
    let hit: BallView | null = null;
    for (const b of this.balls.values()) {
      if (b.n === 0) continue;
      const fx = cx - b.x;
      const fy = cy - b.y;
      const bq = fx * dx + fy * dy;
      const cq = fx * fx + fy * fy - 4 * R * R;
      const disc = bq * bq - cq;
      if (disc < 0) continue;
      const t = -bq - Math.sqrt(disc);
      if (t > 0 && t < tBall) {
        tBall = t;
        hit = b;
      }
    }
    const tx = dx > 0 ? (L - R - cx) / dx : dx < 0 ? (R - cx) / dx : Infinity;
    const ty = dy > 0 ? (W - R - cy) / dy : dy < 0 ? (R - cy) / dy : Infinity;
    const tWall = Math.max(0, Math.min(tx, ty));
    const t = Math.min(tBall, tWall);
    const ex = cx + dx * t;
    const ey = cy + dy * t;
    const game = this.game;
    let legal = true;
    if (hit && game && game.phase !== "break") {
      const target = targetOf(game, game.turn, this.currentBalls());
      legal = target === 8 ? hit.n === 8 : target ? groupOf(hit.n) === target : hit.n !== 8;
    }
    const color = legal ? `rgba(250, 249, 245, ${0.75 * alpha})` : `rgba(230, 110, 100, ${0.85 * alpha})`;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash([16, 12]);
    ctx.beginPath();
    ctx.moveTo(cx + dx * R, cy + dy * R);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(ex, ey, R, 0, Math.PI * 2);
    ctx.stroke();
    if (hit && tBall <= tWall) {
      const nx = (hit.x - ex) / (2 * R);
      const ny = (hit.y - ey) / (2 * R);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(hit.x, hit.y);
      ctx.lineTo(hit.x + nx * 320, hit.y + ny * 320);
      ctx.stroke();
      const dot = dx * nx + dy * ny;
      const px = dx - dot * nx;
      const py = dy - dot * ny;
      const pl = Math.hypot(px, py);
      if (pl > 0.05) {
        ctx.strokeStyle = `rgba(250, 249, 245, ${0.35 * alpha})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex + (px / pl) * 200 * pl, ey + (py / pl) * 200 * pl);
        ctx.stroke();
      }
    } else {
      // 先碰库：画一小段反弹方向
      const rx = tx <= ty ? -dx : dx;
      const ry = tx <= ty ? dy : -dy;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + rx * 220, ey + ry * 220);
      ctx.stroke();
    }
  }

  /** 当前鼠标在台面上的位置（用于外部判断，例如提示） */
  get hover() {
    return this.pointerWorld;
  }

  /** 我方在本局中占的球位 */
  seatsOf(): PoolSeat[] {
    return this.table?.you ?? [];
  }
}
