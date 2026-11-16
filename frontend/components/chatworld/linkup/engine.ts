/** 连连看游戏引擎：Canvas 2D 像素渲染、动画、输入、计时与游戏流程。
 *  React 面板只负责菜单、成绩与道具按钮；引擎在状态变化时回调 onChange，面板再读取 ui() 快照。 */

import {
  type Board, type Cell, type Move, type Rng,
  availablePairs, findPath, generateLevel, get, hintPair, makeRng, remaining, removePair, reshuffle,
} from "./board";
import { COMBO_WINDOW, PAIR_SCORE, TIME_BONUS, comboBonus, type LevelConfig } from "./levels";
import { linkupAudio } from "./sounds";
import { CELL_H, CELL_W, FACE_H, FACE_W, TILE_KINDS, buildAtlas, drawPixelText, type TileAtlas } from "./sprites";

export type Phase = "idle" | "ready" | "playing" | "paused" | "clear" | "over";

export interface LinkupUi {
  phase: Phase;
  config: LevelConfig | null;
  score: number;
  /** 本关开始时的分数（失败重来用） */
  levelStartScore: number;
  combo: number;
  maxCombo: number;
  /** 道具剩余；-1 表示不限 */
  hints: number;
  shuffles: number;
  pairsLeft: number;
  totalPairs: number;
  /** 本关剩余秒数（限时）或已用秒数（不限时），取整 */
  seconds: number;
  /** 过关奖励 */
  timeBonus: number;
  /** 本局累计消除对数 */
  matched: number;
  /** 临时提示（如自动重列），id 递增，面板据此显示一段时间 */
  notice: { id: number; text: string } | null;
}

export interface StartOptions {
  score?: number;
  hints: number;
  shuffles: number;
  maxCombo?: number;
  matched?: number;
}

// ---------------------------------------------------------------- 画面布局（原始像素）

const TOP = 14;
const MX = 15;
const MY = 16;

const COLORS = {
  bg: "#161513",
  cellA: "#1d1c19",
  cellB: "#201f1c",
  frame: "#353431",
  barBack: "#2a2925",
  barGood: "#5db872",
  barWarn: "#d4a017",
  barBad: "#c64545",
  text: "#faf9f5",
  muted: "#8f8e89",
  brand: "#d97757",
  hint: "#64d2e6",
  hover: "#faf9f5",
  lineOuter: "#ff9f1c",
  lineInner: "#fff6c4",
  combo: "#ffd84a",
};

interface Anim {
  /** 起点像素坐标（动画开始时） */
  fx: number;
  fy: number;
  start: number;
  dur: number;
  fade?: boolean;
}

interface Vanish {
  kind: number;
  x: number;
  y: number;
  start: number;
}

interface Link {
  points: { x: number; y: number }[];
  start: number;
  seed: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  born: number;
  life: number;
  size: number;
}

interface FloatText {
  text: string;
  x: number;
  y: number;
  start: number;
  color: string;
  size: number;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export class LinkupEngine {
  private ctx: CanvasRenderingContext2D;
  private atlas: TileAtlas;
  private board: Board | null = null;
  private config: LevelConfig | null = null;
  private rng: Rng = makeRng(1);
  private phase: Phase = "idle";
  private selected: Cell | null = null;
  private hover: Cell | null = null;
  private hint: { a: Cell; b: Cell; until: number } | null = null;
  private shake: { cell: Cell; start: number } | null = null;
  private anims = new Map<number, Anim>();
  private vanishes: Vanish[] = [];
  private links: Link[] = [];
  private particles: Particle[] = [];
  private floats: FloatText[] = [];
  private nativeW = 300;
  private nativeH = 200;
  private scale = 1;
  private frame = 0;
  private last = 0;
  private destroyed = false;
  private resizeObserver: ResizeObserver | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  // 计分与计时
  private score = 0;
  private levelStartScore = 0;
  private combo = 0;
  private maxCombo = 0;
  private lastMatch = -Infinity;
  private hints = 0;
  private shuffles = 0;
  private matched = 0;
  private timeLeft = 0;
  private elapsed = 0;
  private readyAt = 0;
  private timeBonus = 0;
  private lastTick = -1;
  private fastMusic = false;
  private notice: { id: number; text: string } | null = null;
  private totalPairs = 0;

  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, private onChange: () => void) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 Canvas");
    this.ctx = ctx;
    this.atlas = buildAtlas();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
    this.frame = requestAnimationFrame(this.loop);
    // 端到端测试钩子：只有测试脚本预先设置 window.__LINKUP_E2E__ 时才挂到画布上
    if ((window as unknown as { __LINKUP_E2E__?: boolean }).__LINKUP_E2E__) (canvas as unknown as { __linkup?: LinkupEngine }).__linkup = this;
  }

  /** 测试用：一对可以消除的方块在页面上的点击坐标 */
  testPair(): { a: { x: number; y: number }; b: { x: number; y: number } } | null {
    if (!this.board || this.phase !== "playing") return null;
    const pair = hintPair(this.board);
    if (!pair) return null;
    const rect = this.canvas.getBoundingClientRect();
    const toClient = (cell: Cell) => {
      const p = this.center(cell.r, cell.c);
      return { x: rect.left + (p.x / this.nativeW) * rect.width, y: rect.top + (p.y / this.nativeH) * rect.height };
    };
    return { a: toClient(pair[0]), b: toClient(pair[1]) };
  }

  /** 测试用：把剩余时间设为指定秒数 */
  testSetTime(seconds: number) {
    this.timeLeft = seconds;
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    linkupAudio().stopMusic();
  }

  ui(): LinkupUi {
    const config = this.config;
    return {
      phase: this.phase,
      config,
      score: this.score,
      levelStartScore: this.levelStartScore,
      combo: this.combo,
      maxCombo: this.maxCombo,
      hints: this.hints,
      shuffles: this.shuffles,
      pairsLeft: this.board ? remaining(this.board) / 2 : 0,
      totalPairs: this.totalPairs,
      seconds: config?.time ? Math.ceil(this.timeLeft) : Math.floor(this.elapsed),
      timeBonus: this.timeBonus,
      matched: this.matched,
      notice: this.notice,
    };
  }

  private later(ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(timer);
  }

  private emit() {
    this.onChange();
  }

  private say(text: string) {
    this.notice = { id: (this.notice?.id ?? 0) + 1, text };
    this.emit();
  }

  // ---------------------------------------------------------------- 游戏流程

  /** 开始一关：生成盘面、方块落下入场、「准备 - 开始」倒计时 */
  start(config: LevelConfig, options: StartOptions) {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.config = config;
    this.rng = makeRng(config.seed);
    const result = generateLevel({
      rows: config.rows, cols: config.cols, kinds: config.kinds, pool: TILE_KINDS, shift: config.shift, difficulty: config.difficulty,
    }, this.rng);
    this.board = result.board;
    this.totalPairs = (config.rows * config.cols) / 2;
    this.score = options.score ?? 0;
    this.levelStartScore = this.score;
    this.hints = options.hints;
    this.shuffles = options.shuffles;
    this.maxCombo = options.maxCombo ?? 0;
    this.matched = options.matched ?? 0;
    this.combo = 0;
    this.lastMatch = -Infinity;
    this.timeLeft = config.time;
    this.elapsed = 0;
    this.timeBonus = 0;
    this.lastTick = -1;
    this.fastMusic = false;
    this.selected = null;
    this.hint = null;
    this.shake = null;
    this.vanishes = [];
    this.links = [];
    this.particles = [];
    this.floats = [];
    this.anims.clear();
    this.resize();
    // 入场：方块从上方依次落下
    const now = performance.now();
    for (let r = 1; r <= config.rows; r++) {
      for (let c = 1; c <= config.cols; c++) {
        const { x, y } = this.cellPos(r, c);
        this.anims.set(this.key(r, c), { fx: x, fy: y - 26, start: now + (r + c) * 14, dur: 260, fade: true });
      }
    }
    this.phase = "ready";
    this.readyAt = now + 1500;
    const audio = linkupAudio();
    audio.unlock();
    audio.stopMusic();
    audio.play("ready");
    this.later(500, () => audio.play("ready"));
    this.later(1000, () => audio.play("ready"));
    this.later(1500, () => {
      if (this.phase !== "ready") return;
      this.phase = "playing";
      audio.play("go");
      audio.startMusic(false);
      this.emit();
    });
    this.emit();
  }

  togglePause() {
    const audio = linkupAudio();
    if (this.phase === "playing") {
      this.phase = "paused";
      this.selected = null;
      audio.play("pause");
      audio.stopMusic();
      this.emit();
    } else if (this.phase === "paused") {
      this.phase = "playing";
      this.last = performance.now();
      audio.unlock();
      audio.play("resume");
      audio.startMusic(this.fastMusic);
      this.emit();
    }
  }

  /** 回到菜单：清空盘面、停止音乐与计时（成绩由面板在此之前结算） */
  abandon() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.phase = "idle";
    this.board = null;
    this.selected = null;
    this.hint = null;
    this.combo = 0;
    this.particles = [];
    this.floats = [];
    this.links = [];
    this.vanishes = [];
    linkupAudio().stopMusic();
    this.emit();
  }

  /** 提示：高亮一对可以消除的方块 */
  useHint() {
    if (this.phase !== "playing" || !this.board) return;
    if (this.hints === 0) {
      linkupAudio().play("error");
      return;
    }
    const pair = hintPair(this.board);
    if (!pair) return;
    if (this.hints > 0) this.hints--;
    this.hint = { a: pair[0], b: pair[1], until: performance.now() + 9000 };
    linkupAudio().play("hint");
    this.emit();
  }

  /** 重列：打乱剩余方块 */
  useShuffle() {
    if (this.phase !== "playing" || !this.board) return;
    if (this.shuffles === 0) {
      linkupAudio().play("error");
      return;
    }
    if (this.shuffles > 0) this.shuffles--;
    this.doShuffle();
    this.emit();
  }

  private doShuffle() {
    const board = this.board;
    if (!board) return;
    const moves = reshuffle(board, this.rng, 3);
    this.selected = null;
    this.hint = null;
    this.animateMoves(moves, 0, 420, true);
    linkupAudio().play("shuffle");
  }

  private gameOver() {
    this.phase = "over";
    this.selected = null;
    this.hint = null;
    this.combo = 0;
    const audio = linkupAudio();
    audio.stopMusic();
    audio.play("over");
    this.emit();
  }

  private levelClear() {
    if (this.phase !== "playing") return;
    this.phase = "clear";
    this.timeBonus = this.config?.time ? Math.ceil(this.timeLeft) * TIME_BONUS : 0;
    this.score += this.timeBonus;
    const audio = linkupAudio();
    audio.stopMusic();
    audio.play("clear");
    // 庆祝：全屏撒彩色碎片
    const now = performance.now();
    for (let i = 0; i < 90; i++) {
      this.particles.push({
        x: this.rng() * this.nativeW, y: TOP + this.rng() * 30, vx: (this.rng() - 0.5) * 40, vy: 10 + this.rng() * 50,
        color: ["#ffd84a", "#d97757", "#64d2e6", "#5db872", "#f596bd"][i % 5], born: now + this.rng() * 600, life: 1600, size: 2,
      });
    }
    this.emit();
  }

  // ---------------------------------------------------------------- 点击与消除

  private click(cell: Cell) {
    const board = this.board;
    if (this.phase !== "playing" || !board) return;
    const value = get(board, cell.r, cell.c);
    if (!value) return;
    const audio = linkupAudio();
    audio.unlock();
    const sel = this.selected;
    if (!sel) {
      this.selected = cell;
      audio.play("select");
      return;
    }
    if (sel.r === cell.r && sel.c === cell.c) {
      this.selected = null;
      audio.play("deselect");
      return;
    }
    if (get(board, sel.r, sel.c) === value) {
      const path = findPath(board, sel, cell);
      if (path) {
        this.match(sel, cell, path);
        return;
      }
      // 同图案但连不通：提示音 + 抖动，选中改为新点的方块
      audio.play("error");
      this.shake = { cell, start: performance.now() };
      this.selected = cell;
      this.combo = 0;
      this.emit();
      return;
    }
    this.selected = cell;
    audio.play("select");
  }

  private match(a: Cell, b: Cell, path: Cell[]) {
    const board = this.board!;
    const now = performance.now();
    const kind = get(board, a.r, a.c);
    const pa = this.cellPos(a.r, a.c);
    const pb = this.cellPos(b.r, b.c);
    // 连线（消除前的位置）
    this.links.push({ points: path.map(p => this.center(p.r, p.c)), start: now, seed: Math.floor(this.rng() * 1e6) });
    this.vanishes.push({ kind, x: pa.x, y: pa.y, start: now }, { kind, x: pb.x, y: pb.y, start: now });
    this.anims.delete(this.key(a.r, a.c));
    this.anims.delete(this.key(b.r, b.c));
    this.burst(kind, pa.x, pa.y, now + 90);
    this.burst(kind, pb.x, pb.y, now + 90);

    // 计分与连击
    this.combo = now - this.lastMatch <= COMBO_WINDOW ? this.combo + 1 : 1;
    this.lastMatch = now;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const gain = PAIR_SCORE + comboBonus(this.combo);
    this.score += gain;
    this.matched++;
    const mid = { x: (pa.x + pb.x) / 2 + FACE_W / 2, y: (pa.y + pb.y) / 2 };
    this.floats.push({ text: `+${gain}`, x: mid.x, y: mid.y, start: now, color: COLORS.text, size: 1 });
    const audio = linkupAudio();
    audio.play("match", this.combo - 1);
    if (this.combo >= 2) {
      this.floats.push({ text: `COMBO x${this.combo}`, x: mid.x, y: mid.y - 9, start: now + 60, color: COLORS.combo, size: 1 });
      audio.play("combo", this.combo);
    }

    // 消除并按关卡变化移动
    const moves = removePair(board, a, b, this.config!.shift);
    this.selected = null;
    this.hint = null;
    if (moves.length) {
      this.animateMoves(moves, 110, 170, false);
      this.later(110, () => linkupAudio().play("slide"));
    }

    if (remaining(board) === 0) {
      this.later(450, () => this.levelClear());
    } else if (!availablePairs(board, 1).length) {
      // 无路可走：自动重列（不消耗道具）
      this.later(520, () => {
        if (this.phase !== "playing") return;
        this.say("没有可以消除的了 · 自动重列");
        this.doShuffle();
      });
    }
    this.emit();
  }

  private animateMoves(moves: Move[], delay: number, duration: number, scatter: boolean) {
    const now = performance.now();
    // 先记下起点的当前显示位置（若起点本身还在动画中则取动画终点）
    const starts = moves.map(m => this.cellPos(m.from.r, m.from.c));
    moves.forEach((m, i) => {
      this.anims.set(this.key(m.to.r, m.to.c), {
        fx: starts[i].x, fy: starts[i].y, start: now + delay + (scatter ? this.rng() * 120 : 0), dur: duration,
      });
    });
  }

  private burst(kind: number, x: number, y: number, born: number) {
    const colors = this.atlas.colors(kind);
    for (let i = 0; i < 12; i++) {
      const angle = this.rng() * Math.PI * 2;
      const speed = 25 + this.rng() * 55;
      this.particles.push({
        x: x + FACE_W / 2, y: y + FACE_H / 2, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 30,
        color: colors[i % colors.length], born, life: 420 + this.rng() * 260, size: this.rng() < 0.3 ? 2 : 1,
      });
    }
  }

  // ---------------------------------------------------------------- 坐标

  private key(r: number, c: number) {
    return r * 1000 + c;
  }

  /** 格子左上角像素坐标（含边框外一圈，r/c 可为 0 或 rows+1 / cols+1） */
  private cellPos(r: number, c: number) {
    return { x: MX + (c - 1) * CELL_W, y: TOP + MY + (r - 1) * CELL_H };
  }

  /** 牌面中心（连线经过的点） */
  private center(r: number, c: number) {
    const p = this.cellPos(r, c);
    return { x: p.x + FACE_W / 2, y: p.y + FACE_H / 2 };
  }

  private cellAt(clientX: number, clientY: number): Cell | null {
    const config = this.config;
    if (!config) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.nativeW;
    const y = ((clientY - rect.top) / rect.height) * this.nativeH;
    const c = Math.floor((x - MX) / CELL_W) + 1;
    const r = Math.floor((y - TOP - MY) / CELL_H) + 1;
    if (r < 1 || c < 1 || r > config.rows || c > config.cols) return null;
    return { r, c };
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    linkupAudio().unlock();
    const cell = this.cellAt(event.clientX, event.clientY);
    if (cell) {
      event.preventDefault();
      this.click(cell);
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    this.hover = this.cellAt(event.clientX, event.clientY);
  };

  private onPointerLeave = () => {
    this.hover = null;
  };

  private onVisibility = () => {
    if (document.hidden && this.phase === "playing") this.togglePause();
  };

  // ---------------------------------------------------------------- 尺寸

  private resize() {
    const config = this.config;
    const rows = config?.rows ?? 8;
    const cols = config?.cols ?? 14;
    this.nativeW = cols * CELL_W + MX * 2;
    this.nativeH = TOP + rows * CELL_H + MY * 2;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min(width / this.nativeW, height / this.nativeH);
    // 「锐利双线性」：按向上取整的整数倍绘制（每个像素块大小一致），再由浏览器平滑缩小到可用空间，
    // 既铺满面板又不会出现像素块忽大忽小；恰好是整数倍时直接按像素显示
    const exact = fit * dpr;
    const device = exact < 1 ? exact : Math.ceil(exact - 0.02);
    const integral = Math.abs(device - exact) < 0.02;
    this.scale = device;
    this.canvas.width = Math.round(this.nativeW * device);
    this.canvas.height = Math.round(this.nativeH * device);
    this.canvas.style.width = `${Math.floor(this.nativeW * fit)}px`;
    this.canvas.style.height = `${Math.floor(this.nativeH * fit)}px`;
    this.canvas.style.imageRendering = integral ? "pixelated" : "auto";
  }

  // ---------------------------------------------------------------- 主循环

  private loop = (now: number) => {
    if (this.destroyed) return;
    const dt = Math.min(0.1, Math.max(0, (now - (this.last || now)) / 1000));
    this.last = now;
    this.update(now, dt);
    this.render(now);
    this.frame = requestAnimationFrame(this.loop);
  };

  private update(now: number, dt: number) {
    if (this.phase === "playing" && this.config) {
      if (this.config.time) {
        const before = Math.ceil(this.timeLeft);
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        const after = Math.ceil(this.timeLeft);
        if (after !== before) {
          if (after <= 10 && after > 0 && after !== this.lastTick) {
            this.lastTick = after;
            linkupAudio().play("tick", after);
          }
          if (!this.fastMusic && after <= 20) {
            this.fastMusic = true;
            linkupAudio().setFast(true);
          }
          this.emit();
        }
        if (this.timeLeft <= 0) this.gameOver();
      } else {
        const before = Math.floor(this.elapsed);
        this.elapsed += dt;
        if (Math.floor(this.elapsed) !== before) this.emit();
      }
      // 连击超时归零
      if (this.combo && now - this.lastMatch > COMBO_WINDOW) {
        this.combo = 0;
        this.emit();
      }
    }
    if (this.hint && now > this.hint.until) this.hint = null;
    // 粒子
    for (const p of this.particles) {
      if (now < p.born) continue;
      p.vy += 140 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter(p => now < p.born + p.life);
    this.vanishes = this.vanishes.filter(v => now - v.start < 260);
    this.links = this.links.filter(l => now - l.start < 300);
    this.floats = this.floats.filter(f => now - f.start < 900);
    for (const [key, anim] of this.anims) if (now > anim.start + anim.dur) this.anims.delete(key);
  }

  // ---------------------------------------------------------------- 绘制

  private render(now: number) {
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.nativeW, this.nativeH);
    const config = this.config;
    const board = this.board;
    if (!config || !board) return;

    this.drawGrid(config.rows, config.cols);
    this.drawTimer(config);

    const hidden = this.phase === "paused";
    // 方块：从上到下、从左到右，下方的方块压住上方方块的侧边
    for (let r = 1; r <= config.rows; r++) {
      for (let c = 1; c <= config.cols; c++) {
        const kind = get(board, r, c);
        if (!kind) continue;
        this.drawTile(now, r, c, hidden ? 0 : kind);
      }
    }

    // 消失中的方块：闪白后缩小
    for (const v of this.vanishes) {
      const t = (now - v.start) / 260;
      const k = 1 - easeOut(t);
      const w = Math.max(1, Math.round(CELL_W * k));
      const h = Math.max(1, Math.round(CELL_H * k));
      const x = Math.round(v.x + (CELL_W - w) / 2);
      const y = Math.round(v.y + (CELL_H - h) / 2);
      ctx.globalAlpha = 1 - t * 0.6;
      ctx.drawImage(this.atlas.tile(v.kind, "selected"), x, y, w, h);
      if (t < 0.45) {
        ctx.globalAlpha = 0.85 * (1 - t / 0.45);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, Math.round(w * FACE_W / CELL_W), Math.round(h * FACE_H / CELL_H));
      }
      ctx.globalAlpha = 1;
    }

    for (const link of this.links) this.drawLink(now, link);

    for (const p of this.particles) {
      if (now < p.born) continue;
      const t = (now - p.born) / p.life;
      ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;

    for (const f of this.floats) {
      if (now < f.start) continue;
      const t = (now - f.start) / 900;
      ctx.globalAlpha = t > 0.6 ? (1 - t) / 0.4 : 1;
      const width = f.text.length * 4 * f.size - f.size;
      drawPixelText(ctx, f.text, Math.round(f.x - width / 2), Math.round(f.y - easeOut(t) * 12), f.size, f.color, "#1a1410");
    }
    ctx.globalAlpha = 1;
  }

  private drawGrid(rows: number, cols: number) {
    const ctx = this.ctx;
    const x0 = MX;
    const y0 = TOP + MY;
    // 棋盘格底纹：消掉的位置露出浅浅的格子
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = (r + c) % 2 ? COLORS.cellA : COLORS.cellB;
        ctx.fillRect(x0 + c * CELL_W, y0 + r * CELL_H, CELL_W, CELL_H);
      }
    }
    // 像素边框（四角缺口）
    ctx.fillStyle = COLORS.frame;
    const w = cols * CELL_W;
    const h = rows * CELL_H;
    ctx.fillRect(x0 - 3, y0 - 4, w + 6, 1);
    ctx.fillRect(x0 - 3, y0 + h + 3, w + 6, 1);
    ctx.fillRect(x0 - 4, y0 - 3, 1, h + 6);
    ctx.fillRect(x0 + w + 3, y0 - 3, 1, h + 6);
  }

  private drawTimer(config: LevelConfig) {
    const ctx = this.ctx;
    const y = 5;
    const label = config.time ? "TIME" : "TIME";
    drawPixelText(ctx, label, MX - 2, y, 1, COLORS.muted);
    const x = MX + 18;
    const digits = config.time ? String(Math.ceil(this.timeLeft)) : formatClock(this.elapsed);
    const textW = digits.length * 4 - 1;
    const end = this.nativeW - MX - textW - 4;
    if (config.time) {
      const k = Math.max(0, Math.min(1, this.timeLeft / config.time));
      const width = Math.round((end - x) * k);
      ctx.fillStyle = COLORS.barBack;
      ctx.fillRect(x, y, end - x, 5);
      const warn = this.timeLeft <= 10;
      const blink = warn && Math.floor(performance.now() / 250) % 2 === 0;
      ctx.fillStyle = this.timeLeft <= 10 ? (blink ? "#ff6a5a" : COLORS.barBad) : this.timeLeft <= 30 ? COLORS.barWarn : COLORS.barGood;
      ctx.fillRect(x, y, width, 5);
      // 像素刻度
      ctx.fillStyle = COLORS.bg;
      for (let tx = x + 8; tx < x + width; tx += 8) ctx.fillRect(tx, y, 1, 5);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(x, y, width, 1);
      drawPixelText(ctx, digits, this.nativeW - MX - textW + 2, y, 1, warn ? COLORS.barBad : COLORS.text);
    } else {
      ctx.fillStyle = COLORS.barBack;
      ctx.fillRect(x, y + 2, end - x, 1);
      drawPixelText(ctx, digits, this.nativeW - MX - textW + 2, y, 1, COLORS.text);
    }
  }

  private drawTile(now: number, r: number, c: number, kind: number) {
    const ctx = this.ctx;
    let { x, y } = this.cellPos(r, c);
    let alpha = 1;
    const anim = this.anims.get(this.key(r, c));
    if (anim) {
      const t = Math.max(0, Math.min(1, (now - anim.start) / anim.dur));
      const e = easeOut(t);
      x = anim.fx + (x - anim.fx) * e;
      y = anim.fy + (y - anim.fy) * e;
      if (anim.fade) alpha = t;
    }
    const sel = this.selected;
    const isSelected = Boolean(sel && sel.r === r && sel.c === c);
    if (this.shake && this.shake.cell.r === r && this.shake.cell.c === c) {
      const t = (now - this.shake.start) / 240;
      if (t < 1) x += Math.round(Math.sin(t * Math.PI * 6) * 2 * (1 - t));
      else this.shake = null;
    }
    if (isSelected) y -= 1;
    x = Math.round(x);
    y = Math.round(y);
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    if (!kind) {
      // 暂停时只画牌背，防止偷看
      ctx.drawImage(this.atlas.tile(0, "normal"), x, y);
      ctx.globalAlpha = 1;
      return;
    }
    ctx.drawImage(this.atlas.tile(kind, isSelected ? "selected" : "normal"), x, y);
    ctx.globalAlpha = 1;
    const hint = this.hint;
    const hinted = hint && ((hint.a.r === r && hint.a.c === c) || (hint.b.r === r && hint.b.c === c));
    if (isSelected) {
      const blink = Math.floor(now / 180) % 2 === 0;
      this.outline(x, y, blink ? COLORS.brand : "#ffb38a", 2);
    } else if (hinted) {
      const pulse = Math.floor(now / 220) % 2 === 0;
      this.outline(x, y, pulse ? COLORS.hint : "#c8f4ff", pulse ? 2 : 1);
    } else if (this.hover && this.hover.r === r && this.hover.c === c && this.phase === "playing") {
      this.outline(x, y, "rgba(250,249,245,0.75)", 1);
    }
  }

  /** 牌面外描边 */
  private outline(x: number, y: number, color: string, width: number) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.fillRect(x - width, y - width, FACE_W + width * 2, width);
    ctx.fillRect(x - width, y + FACE_H, FACE_W + width * 2, width);
    ctx.fillRect(x - width, y, width, FACE_H);
    ctx.fillRect(x + FACE_W, y, width, FACE_H);
  }

  /** 闪电连线：折线每段细分并随机抖动，外层橙色、内芯亮黄，拐点处闪光 */
  private drawLink(now: number, link: Link) {
    const ctx = this.ctx;
    const t = (now - link.start) / 300;
    const rng = makeRng(link.seed + Math.floor(now / 45));
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < link.points.length; i++) {
      const a = link.points[i];
      const b = link.points[i + 1];
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const steps = Math.max(1, Math.round(len / 6));
      for (let s = 0; s < steps; s++) {
        const k = s / steps;
        const jitter = s === 0 ? 0 : (rng() - 0.5) * 3;
        pts.push({ x: a.x + (b.x - a.x) * k + (a.y !== b.y ? jitter : 0), y: a.y + (b.y - a.y) * k + (a.x !== b.x ? jitter : 0) });
      }
    }
    pts.push(link.points[link.points.length - 1]);
    ctx.globalAlpha = t > 0.6 ? (1 - t) / 0.4 : 1;
    ctx.lineCap = "square";
    ctx.lineJoin = "miter";
    for (const [color, width] of [[COLORS.lineOuter, 3], [COLORS.lineInner, 1]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    // 端点与拐点的闪光
    ctx.fillStyle = "#ffffff";
    for (const p of link.points) {
      const size = 3 + (Math.floor(now / 60) % 2);
      ctx.fillRect(Math.round(p.x - size / 2), Math.round(p.y - 0.5), size, 1);
      ctx.fillRect(Math.round(p.x - 0.5), Math.round(p.y - size / 2), 1, size);
    }
    ctx.globalAlpha = 1;
  }
}

function formatClock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
