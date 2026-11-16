/** 连连看核心算法（纯函数，不依赖浏览器）：棋盘、两折以内连线寻路、11 种关卡变化（消除后方块移动）、
 *  无解检测与重列、可解性求解器，以及带难度控制的关卡生成。
 *
 *  坐标约定：棋盘内部格子 rows × cols，外面包一圈空白边框（连线可以从棋盘外绕过去），
 *  因此存储网格为 (rows + 2) × (cols + 2)，内部格子的行列从 1 开始。0 表示空格，>0 为方块图案编号。 */

export interface Cell {
  r: number;
  c: number;
}

export interface Board {
  rows: number;
  cols: number;
  /** 行优先存储的 (rows + 2) × (cols + 2) 网格 */
  cells: number[];
}

/** 消除后的方块移动方式（经典连连看的 11 种关卡变化） */
export type Shift =
  | "none" | "down" | "left" | "up" | "right"
  | "split-v" | "split-h" | "gather-v" | "gather-h"
  | "up-left-down-right" | "left-down-right-up";

export const SHIFTS: Shift[] = [
  "none", "down", "left", "up", "right", "split-v", "split-h", "gather-v", "gather-h", "up-left-down-right", "left-down-right-up",
];

export const SHIFT_LABEL: Record<Shift, string> = {
  none: "不变化",
  down: "向下",
  left: "向左",
  up: "向上",
  right: "向右",
  "split-v": "上下分离",
  "split-h": "左右分离",
  "gather-v": "上下集中",
  "gather-h": "左右集中",
  "up-left-down-right": "上左下右",
  "left-down-right-up": "左下右上",
};

// ---------------------------------------------------------------- 随机数

/** 可复现的伪随机数（mulberry32）：每日挑战用日期做种子，所有人拿到同一个盘面 */
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位种子 */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function shuffleInPlace<T>(list: T[], rng: Rng): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ---------------------------------------------------------------- 棋盘基础

export function emptyBoard(rows: number, cols: number): Board {
  return { rows, cols, cells: new Array((rows + 2) * (cols + 2)).fill(0) };
}

export function cloneBoard(board: Board): Board {
  return { rows: board.rows, cols: board.cols, cells: board.cells.slice() };
}

export function idx(board: Board, r: number, c: number): number {
  return r * (board.cols + 2) + c;
}

export function get(board: Board, r: number, c: number): number {
  if (r < 0 || c < 0 || r > board.rows + 1 || c > board.cols + 1) return 0;
  return board.cells[idx(board, r, c)];
}

export function set(board: Board, r: number, c: number, value: number): void {
  board.cells[idx(board, r, c)] = value;
}

/** 内部所有格子坐标（行优先） */
export function innerCells(board: Board): Cell[] {
  const out: Cell[] = [];
  for (let r = 1; r <= board.rows; r++) for (let c = 1; c <= board.cols; c++) out.push({ r, c });
  return out;
}

export function occupied(board: Board): Cell[] {
  return innerCells(board).filter(p => get(board, p.r, p.c) > 0);
}

export function remaining(board: Board): number {
  let n = 0;
  for (const v of board.cells) if (v > 0) n++;
  return n;
}

// ---------------------------------------------------------------- 连线寻路

/** 折线经过的全部格子（含端点） */
function walk(from: Cell, to: Cell, visit: (r: number, c: number) => boolean): boolean {
  const dr = Math.sign(to.r - from.r);
  const dc = Math.sign(to.c - from.c);
  let r = from.r;
  let c = from.c;
  for (;;) {
    if (!visit(r, c)) return false;
    if (r === to.r && c === to.c) return true;
    r += dr;
    c += dc;
  }
}

/** 去掉重复点、合并共线点，得到折线拐点 */
function simplify(points: Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.r === p.r && last.c === p.c) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1], b = out[i], d = out[i + 1];
    if ((a.r === b.r && b.r === d.r) || (a.c === b.c && b.c === d.c)) out.splice(i, 1);
  }
  return out;
}

/** 折线是否畅通：除起点、终点外，路径经过的每个格子都必须为空（中途经过端点自身也算被挡住） */
function clear(board: Board, points: Cell[]): boolean {
  const total = pathLength(points) + 1;
  let k = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const ok = walk(points[i], points[i + 1], (r, c) => {
      // 每段的起点是上一段的终点，已经算过
      if (i > 0 && r === points[i].r && c === points[i].c) return true;
      const inner = k !== 0 && k !== total - 1;
      k++;
      return !inner || get(board, r, c) === 0;
    });
    if (!ok) return false;
  }
  return true;
}

function pathLength(points: Cell[]): number {
  let n = 0;
  for (let i = 0; i + 1 < points.length; i++) n += Math.abs(points[i + 1].r - points[i].r) + Math.abs(points[i + 1].c - points[i].c);
  return n;
}

/** 两个格子之间不超过两个拐弯的连线。任意「两折以内」的路径都可以写成：
 *  竖-横-竖（由横段所在行决定）或 横-竖-横（由竖段所在列决定），直线和一折是其特例。
 *  枚举所有行、列即可覆盖全部候选；返回拐弯最少、其次最短的一条（拐点序列），不通时返回 null。
 *  first=true 时找到任意一条立即返回（求解器只关心能否连通）。 */
export function findPath(board: Board, a: Cell, b: Cell, first = false): Cell[] | null {
  if (a.r === b.r && a.c === b.c) return null;
  let best: Cell[] | null = null;
  let bestKey = Infinity;
  const consider = (raw: Cell[]) => {
    const points = simplify(raw);
    if (!clear(board, points)) return false;
    const key = (points.length - 2) * 1000 + pathLength(points);
    if (key < bestKey) {
      bestKey = key;
      best = points;
    }
    return first;
  };
  for (let r = 0; r <= board.rows + 1; r++) {
    if (consider([a, { r, c: a.c }, { r, c: b.c }, b])) return best;
  }
  for (let c = 0; c <= board.cols + 1; c++) {
    if (consider([a, { r: a.r, c }, { r: b.r, c }, b])) return best;
  }
  return best;
}

export function canLink(board: Board, a: Cell, b: Cell): boolean {
  const va = get(board, a.r, a.c);
  return va > 0 && va === get(board, b.r, b.c) && findPath(board, a, b, true) !== null;
}

/** 按图案分组的方块位置 */
function groups(board: Board): Map<number, Cell[]> {
  const map = new Map<number, Cell[]>();
  for (let r = 1; r <= board.rows; r++) {
    for (let c = 1; c <= board.cols; c++) {
      const v = get(board, r, c);
      if (v <= 0) continue;
      const list = map.get(v);
      if (list) list.push({ r, c });
      else map.set(v, [{ r, c }]);
    }
  }
  return map;
}

/** 当前所有可消除的一对（limit 限制数量，提前结束） */
export function availablePairs(board: Board, limit = Infinity): [Cell, Cell][] {
  const out: [Cell, Cell][] = [];
  for (const list of groups(board).values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (findPath(board, list[i], list[j], true)) {
          out.push([list[i], list[j]]);
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

/** 提示：优先给出连线最短的一对，更像「指南针」指出的显眼位置 */
export function hintPair(board: Board): [Cell, Cell] | null {
  let best: [Cell, Cell] | null = null;
  let bestLen = Infinity;
  for (const [a, b] of availablePairs(board)) {
    const path = findPath(board, a, b);
    if (!path) continue;
    const len = (path.length - 2) * 100 + pathLength(path);
    if (len < bestLen) {
      bestLen = len;
      best = [a, b];
    }
  }
  return best;
}

// ---------------------------------------------------------------- 关卡变化（消除后方块移动）

export interface Move {
  from: Cell;
  to: Cell;
}

/** 把一条线上的方块往 toward 端压紧；line 为该线上的格子坐标（从 toward 端开始排列） */
function compact(board: Board, line: Cell[], moves: Move[]): void {
  const tiles: { v: number; from: Cell }[] = [];
  for (const p of line) {
    const v = get(board, p.r, p.c);
    if (v > 0) tiles.push({ v, from: p });
    set(board, p.r, p.c, 0);
  }
  tiles.forEach((tile, i) => {
    const to = line[i];
    set(board, to.r, to.c, tile.v);
    if (to.r !== tile.from.r || to.c !== tile.from.c) moves.push({ from: tile.from, to });
  });
}

function column(c: number, r0: number, r1: number): Cell[] {
  const out: Cell[] = [];
  const step = r1 >= r0 ? 1 : -1;
  for (let r = r0; r !== r1 + step; r += step) out.push({ r, c });
  return out;
}

function row(r: number, c0: number, c1: number): Cell[] {
  const out: Cell[] = [];
  const step = c1 >= c0 ? 1 : -1;
  for (let c = c0; c !== c1 + step; c += step) out.push({ r, c });
  return out;
}

/** 按关卡变化方式移动方块（就地修改），返回移动列表供动画使用。
 *  奇数行列时中线归入后半（上半 / 左半少一格）。 */
export function applyShift(board: Board, shift: Shift): Move[] {
  const moves: Move[] = [];
  const { rows, cols } = board;
  const midR = Math.floor(rows / 2); // 上半：1..midR，下半：midR+1..rows
  const midC = Math.floor(cols / 2);
  switch (shift) {
    case "none":
      break;
    case "down":
      for (let c = 1; c <= cols; c++) compact(board, column(c, rows, 1), moves);
      break;
    case "up":
      for (let c = 1; c <= cols; c++) compact(board, column(c, 1, rows), moves);
      break;
    case "left":
      for (let r = 1; r <= rows; r++) compact(board, row(r, 1, cols), moves);
      break;
    case "right":
      for (let r = 1; r <= rows; r++) compact(board, row(r, cols, 1), moves);
      break;
    case "split-v":
      for (let c = 1; c <= cols; c++) {
        compact(board, column(c, 1, midR), moves);
        compact(board, column(c, rows, midR + 1), moves);
      }
      break;
    case "gather-v":
      for (let c = 1; c <= cols; c++) {
        compact(board, column(c, midR, 1), moves);
        compact(board, column(c, midR + 1, rows), moves);
      }
      break;
    case "split-h":
      for (let r = 1; r <= rows; r++) {
        compact(board, row(r, 1, midC), moves);
        compact(board, row(r, cols, midC + 1), moves);
      }
      break;
    case "gather-h":
      for (let r = 1; r <= rows; r++) {
        compact(board, row(r, midC, 1), moves);
        compact(board, row(r, midC + 1, cols), moves);
      }
      break;
    case "up-left-down-right":
      // 上半部分向左压紧，下半部分向右压紧
      for (let r = 1; r <= midR; r++) compact(board, row(r, 1, cols), moves);
      for (let r = midR + 1; r <= rows; r++) compact(board, row(r, cols, 1), moves);
      break;
    case "left-down-right-up":
      // 左半部分向下压紧，右半部分向上压紧
      for (let c = 1; c <= midC; c++) compact(board, column(c, rows, 1), moves);
      for (let c = midC + 1; c <= cols; c++) compact(board, column(c, 1, rows), moves);
      break;
  }
  return moves;
}

/** 消除一对并按关卡变化移动，返回移动列表 */
export function removePair(board: Board, a: Cell, b: Cell, shift: Shift): Move[] {
  set(board, a.r, a.c, 0);
  set(board, b.r, b.c, 0);
  return applyShift(board, shift);
}

// ---------------------------------------------------------------- 求解器

export interface SolveResult {
  solved: boolean;
  /** 找到的解法路线上，每一步平均可选的消除数（越少越难，用作难度指标） */
  branching: number;
  /** 搜索展开的盘面数 */
  nodes: number;
}

/** 剩余数量最少的图案优先：同种只剩两块时必须让它们连通，越早处理越不容易被移动的方块堵死 */
function orderPairs(board: Board, pairs: [Cell, Cell][], rng: Rng): [Cell, Cell][] {
  const counts = new Map<number, number>();
  for (const v of board.cells) if (v > 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  return pairs
    .map(pair => ({ pair, key: (counts.get(get(board, pair[0].r, pair[0].c)) ?? 0) + rng() * 3 }))
    .sort((x, y) => x.key - y.key)
    .map(item => item.pair);
}

/** 求解器：带回溯的深度优先搜索（模拟关卡变化），记住走过的死局盘面，展开数超过 budget 时放弃。
 *  随机贪心在「向左 / 左右集中」等横向变化下很容易走进死局，回溯能可靠地判定这些盘面可解。 */
export function solve(board: Board, shift: Shift, rng: Rng, budget = 4000): SolveResult {
  const dead = new Set<string>();
  let nodes = 0;
  const branches: number[] = [];
  const dfs = (work: Board): boolean => {
    if (remaining(work) === 0) return true;
    if (nodes >= budget) return false;
    const key = work.cells.join(",");
    if (dead.has(key)) return false;
    nodes++;
    const pairs = availablePairs(work, 60);
    const ordered = orderPairs(work, pairs, rng);
    // 每层最多尝试前 6 种走法：解通常很多，限制宽度避免在一个死胡同里耗尽预算
    for (const [a, b] of ordered.slice(0, 6)) {
      const next = cloneBoard(work);
      removePair(next, a, b, shift);
      branches.push(pairs.length);
      if (dfs(next)) return true;
      branches.pop();
      if (nodes >= budget) return false;
    }
    dead.add(key);
    return false;
  };
  const solved = dfs(cloneBoard(board));
  const branching = branches.length ? branches.reduce((s, n) => s + n, 0) / branches.length : 0;
  return { solved, branching, nodes };
}

// ---------------------------------------------------------------- 重列

/** 打乱剩余方块（位置不变，只交换图案），保证打乱后至少有 minMoves 对可消除。
 *  多次随机仍不满足时，强制把某种图案的两个方块换到相邻位置。 */
export function reshuffle(board: Board, rng: Rng, minMoves = 1): Move[] {
  const cells = occupied(board);
  if (cells.length < 2) return [];
  const original = cells.map(p => get(board, p.r, p.c));
  let order = cells.map((_, i) => i);
  let ok = false;
  for (let attempt = 0; attempt < 60 && !ok; attempt++) {
    order = shuffleInPlace(cells.map((_, i) => i), rng);
    cells.forEach((p, i) => set(board, p.r, p.c, original[order[i]]));
    ok = availablePairs(board, minMoves).length >= Math.min(minMoves, Math.floor(cells.length / 2));
  }
  if (!ok) {
    // 兜底：找一对相邻格子，把同一种图案的两块换过去
    for (const p of cells) {
      const q = cells.find(o => (Math.abs(o.r - p.r) + Math.abs(o.c - p.c)) === 1);
      if (!q) continue;
      const v = get(board, p.r, p.c);
      const twin = cells.find(o => (o.r !== p.r || o.c !== p.c) && get(board, o.r, o.c) === v);
      if (!twin) continue;
      const tmp = get(board, q.r, q.c);
      const twinIndex = cells.indexOf(twin);
      const qIndex = cells.indexOf(q);
      set(board, q.r, q.c, v);
      set(board, twin.r, twin.c, tmp);
      [order[qIndex], order[twinIndex]] = [order[twinIndex], order[qIndex]];
      break;
    }
  }
  // 动画：每个格子的新图案来自原来哪个格子
  return cells.map((to, i) => ({ from: cells[order[i]], to })).filter(m => m.from.r !== m.to.r || m.from.c !== m.to.c);
}

// ---------------------------------------------------------------- 关卡生成

export interface GenOptions {
  rows: number;
  cols: number;
  /** 图案种类数 */
  kinds: number;
  /** 可用图案编号池（从中随机选 kinds 种） */
  pool: number;
  shift: Shift;
  /** 目标难度 0（简单）– 1（困难）：越难，开局可消对数越少、同图案越分散 */
  difficulty: number;
}

export interface GenResult {
  board: Board;
  /** 开局可消除的对数 */
  openMoves: number;
  /** 同图案相邻的对数 */
  adjacent: number;
  /** 生成时尝试的盘面数 */
  attempts: number;
  /** 生成时编排好的一条完整消除路线（每步消除时两块所在的位置）；兜底的随机盘面为空 */
  route: [Cell, Cell][];
}

/** 把 pairs 对分配给 kinds 种图案：每种至少一对，余数随机分给部分图案 */
function tileBag(pairs: number, kinds: number, pool: number, rng: Rng): number[] {
  const ids = shuffleInPlace(Array.from({ length: pool }, (_, i) => i + 1), rng).slice(0, Math.min(kinds, pool, pairs));
  const bag: number[] = [];
  const base = Math.floor(pairs / ids.length);
  const extra = pairs - base * ids.length;
  const bonus = new Set(shuffleInPlace(ids.slice(), rng).slice(0, extra));
  for (const id of ids) {
    const n = base + (bonus.has(id) ? 1 : 0);
    for (let i = 0; i < n; i++) bag.push(id, id);
  }
  return bag;
}

/** 同图案相邻（上下左右）的对数：越多越容易 */
function adjacency(board: Board): number {
  let n = 0;
  for (let r = 1; r <= board.rows; r++) {
    for (let c = 1; c <= board.cols; c++) {
      const v = get(board, r, c);
      if (!v) continue;
      if (get(board, r, c + 1) === v) n++;
      if (get(board, r + 1, c) === v) n++;
    }
  }
  return n;
}

/** 正向编排生成（对所有关卡变化都保证有解）：
 *  先在一个「只有占位、没有图案」的满盘上正向模拟游戏——每次挑两个在当前占位下能连通（两折以内）的方块，
 *  记为一对并消除，再按本关的变化方式移动剩余方块；如此直到清空，得到一条完整的消除路线。
 *  连通与否只取决于格子是否为空、与图案无关，所以最后再把图案成对分配给这些「对」，
 *  按这条路线消除一定能清空——无论方块在途中怎样移动。
 *  spread 控制挑选的两块之间的距离偏好：难度越高越偏向相距较远、需要拐弯的组合（玩家不容易一眼看到）。 */
function forwardBuild(rows: number, cols: number, bag: number[], shift: Shift, rng: Rng, spread: number): { board: Board; route: [Cell, Cell][] } | null {
  // 每个方块一个编号（1..N），随移动带着走
  const work = emptyBoard(rows, cols);
  innerCells(work).forEach((p, i) => set(work, p.r, p.c, i + 1));
  const start = cloneBoard(work);
  const pairOf = new Map<number, number>();
  const route: [Cell, Cell][] = [];
  let pairIndex = 0;
  while (remaining(work) > 0) {
    // 只有至少一侧挨着空格（或在边上）的方块才可能连出去
    const open = occupied(work).filter(p =>
      get(work, p.r - 1, p.c) === 0 || get(work, p.r + 1, p.c) === 0 || get(work, p.r, p.c - 1) === 0 || get(work, p.r, p.c + 1) === 0);
    const candidates: [Cell, Cell][] = [];
    for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) candidates.push([open[i], open[j]]);
    shuffleInPlace(candidates, rng);
    const valid: { pair: [Cell, Cell]; turns: number; dist: number }[] = [];
    for (const pair of candidates) {
      const path = findPath(work, pair[0], pair[1]);
      if (!path) continue;
      valid.push({ pair, turns: path.length - 2, dist: Math.abs(pair[0].r - pair[1].r) + Math.abs(pair[0].c - pair[1].c) });
      if (valid.length >= 10) break;
    }
    if (!valid.length) return null;
    // 难度偏好：spread 高时选拐弯多、距离远的；低时选直连、相邻的；带随机扰动
    valid.sort((x, y) => {
      const wx = (x.turns * 3 + Math.min(x.dist, 8)) * (spread - 0.5) + rng() * 4;
      const wy = (y.turns * 3 + Math.min(y.dist, 8)) * (spread - 0.5) + rng() * 4;
      return wy - wx;
    });
    const [a, b] = valid[0].pair;
    pairOf.set(get(work, a.r, a.c), pairIndex);
    pairOf.set(get(work, b.r, b.c), pairIndex);
    pairIndex++;
    route.push([a, b]);
    removePair(work, a, b, shift);
  }
  // 给每一对分配图案
  const kinds: number[] = [];
  for (let i = 0; i < bag.length; i += 2) kinds.push(bag[i]);
  shuffleInPlace(kinds, rng);
  const board = emptyBoard(rows, cols);
  for (const p of innerCells(start)) {
    const id = get(start, p.r, p.c);
    set(board, p.r, p.c, kinds[pairOf.get(id) ?? 0]);
  }
  return { board, route };
}

/** 随机铺满（仅作兜底） */
function randomFill(rows: number, cols: number, bag: number[], rng: Rng): Board {
  const board = emptyBoard(rows, cols);
  const tiles = shuffleInPlace(bag.slice(), rng);
  innerCells(board).forEach((p, i) => set(board, p.r, p.c, tiles[i] ?? 0));
  return board;
}

/** 生成一关：用正向编排生成若干个保证有解的候选盘面，按难度指标挑最接近目标的一个。
 *  难度指标：开局可消对数（越少越难）与同图案相邻程度（越多越容易）。 */
export function generateLevel(options: GenOptions, rng: Rng): GenResult {
  const { rows, cols, kinds, pool, shift } = options;
  const difficulty = Math.max(0, Math.min(1, options.difficulty));
  const pairs = Math.floor((rows * cols) / 2);
  // 目标：开局可消对数随难度从约 14 降到约 4（种类越多可消对数天然越少，这里在同等种类下挑选）
  const targetOpen = 14 - difficulty * 10;
  const candidates = 5;
  let best: GenResult | null = null;
  let bestScore = Infinity;
  let attempts = 0;
  for (let i = 0; i < 20 && (attempts < candidates || !best); i++) {
    attempts++;
    const bag = tileBag(pairs, kinds, pool, rng);
    const built = forwardBuild(rows, cols, bag, shift, rng, difficulty);
    if (!built) continue;
    const { board, route } = built;
    const openMoves = availablePairs(board).length;
    if (openMoves < 2) continue;
    const adj = adjacency(board);
    const score = Math.abs(openMoves - targetOpen) + (difficulty - 0.4) * adj * 0.6;
    if (score < bestScore) {
      bestScore = score;
      best = { board, openMoves, adjacent: adj, attempts, route };
    }
  }
  if (!best) {
    // 极端情况兜底：随机盘面 + 重列保证至少有可消除的一对（游戏中无解时会自动重列）
    const board = randomFill(rows, cols, tileBag(pairs, kinds, pool, rng), rng);
    reshuffle(board, rng, 3);
    best = { board, openMoves: availablePairs(board).length, adjacent: adjacency(board), attempts, route: [] };
  }
  best.attempts = attempts;
  return best;
}
