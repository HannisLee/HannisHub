import type { Rect, RoomDef } from "./layout";

/** 寻路网格边长（像素）：比 16px 地砖更细，能穿过家具之间的窄通道 */
const CELL = 4;
/** 角色碰撞体（与 Player 的 body 一致）：以脚底中心为基准，宽 10、高 6 */
const BODY_HALF_W = 5;
const BODY_H = 6;

export interface Point {
  x: number;
  y: number;
}

/** 单个房间的可行走网格；坐标均为房间局部像素坐标 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly walkable: Uint8Array;

  constructor(room: RoomDef) {
    this.cols = Math.floor(room.width / CELL);
    this.rows = Math.floor(room.height / CELL);
    this.walkable = new Uint8Array(this.cols * this.rows);
    const solids: Rect[] = [
      ...room.walls,
      ...room.props.flatMap(p => (p.solid ? [p.solid] : [])),
      ...room.anims.flatMap(a => (a.solid ? [a.solid] : [])),
    ];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const fx = c * CELL + CELL / 2;
        const fy = r * CELL + CELL / 2;
        const left = fx - BODY_HALF_W;
        const right = fx + BODY_HALF_W;
        const top = fy - BODY_H;
        const inside = left >= 0 && top >= 0 && right <= room.width && fy <= room.height;
        const blocked = !inside || solids.some(([x, y, w, h]) => left < x + w && right > x && top < y + h && fy > y);
        this.walkable[r * this.cols + c] = blocked ? 0 : 1;
      }
    }
  }

  private index(c: number, r: number) {
    return r * this.cols + c;
  }

  private open(c: number, r: number) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.walkable[this.index(c, r)] === 1;
  }

  private cellOf(p: Point): [number, number] {
    return [Math.floor(p.x / CELL), Math.floor(p.y / CELL)];
  }

  private center(c: number, r: number): Point {
    return { x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 };
  }

  /** 离给定点最近的可行走格（由近及远逐圈查找） */
  nearestOpen(p: Point, maxRadius = 16): [number, number] | null {
    const [c0, r0] = this.cellOf(p);
    if (this.open(c0, r0)) return [c0, r0];
    for (let radius = 1; radius <= maxRadius; radius++) {
      let best: [number, number] | null = null;
      let bestDist = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (!this.open(c, r)) continue;
          const d = dc * dc + dr * dr;
          if (d < bestDist) {
            bestDist = d;
            best = [c, r];
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** 矩形区域内离其中心最近的可行走点（用于把传送门作为目标） */
  targetIn([x, y, w, h]: Rect): Point | null {
    const cx = x + w / 2;
    const cy = y + h / 2;
    let best: Point | null = null;
    let bestDist = Infinity;
    for (let r = Math.floor(y / CELL); r <= Math.floor((y + h - 1) / CELL); r++) {
      for (let c = Math.floor(x / CELL); c <= Math.floor((x + w - 1) / CELL); c++) {
        if (!this.open(c, r)) continue;
        const p = this.center(c, r);
        const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
    }
    if (best) return best;
    const near = this.nearestOpen({ x: cx, y: cy });
    return near ? this.center(near[0], near[1]) : null;
  }

  /** A* 八方向寻路（禁止斜穿墙角），再做视线拉直；返回不含起点的路点，找不到时返回 null */
  findPath(from: Point, to: Point): Point[] | null {
    const start = this.nearestOpen(from);
    const goal = this.nearestOpen(to);
    if (!start || !goal) return null;
    const total = this.cols * this.rows;
    const g = new Float32Array(total).fill(Infinity);
    const parent = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const startIdx = this.index(start[0], start[1]);
    const goalIdx = this.index(goal[0], goal[1]);
    const heuristic = (c: number, r: number) => {
      const dx = Math.abs(c - goal[0]);
      const dy = Math.abs(r - goal[1]);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const heap = new MinHeap();
    g[startIdx] = 0;
    heap.push(startIdx, heuristic(start[0], start[1]));
    let found = false;
    while (heap.size > 0) {
      const current = heap.pop();
      if (closed[current]) continue;
      closed[current] = 1;
      if (current === goalIdx) {
        found = true;
        break;
      }
      const c = current % this.cols;
      const r = Math.floor(current / this.cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (!this.open(nc, nr)) continue;
          if (dc && dr && (!this.open(c + dc, r) || !this.open(c, r + dr))) continue;
          const next = this.index(nc, nr);
          if (closed[next]) continue;
          const cost = g[current] + (dc && dr ? Math.SQRT2 : 1);
          if (cost < g[next]) {
            g[next] = cost;
            parent[next] = current;
            heap.push(next, cost + heuristic(nc, nr));
          }
        }
      }
    }
    if (!found) return null;
    const cells: Point[] = [];
    for (let i = goalIdx; i !== -1; i = parent[i]) cells.push(this.center(i % this.cols, Math.floor(i / this.cols)));
    cells.reverse();
    cells[cells.length - 1] = { ...to };
    return this.smooth({ ...from }, cells);
  }

  /** 两点之间的直线是否全程可走（按半格采样） */
  private clear(a: Point, b: Point): boolean {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const [c, r] = this.cellOf({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (!this.open(c, r)) return false;
    }
    return true;
  }

  /** 视线拉直：从当前锚点出发，跳到最远的可直达路点 */
  private smooth(from: Point, cells: Point[]): Point[] {
    const result: Point[] = [];
    let anchor = from;
    let i = 0;
    while (i < cells.length) {
      let j = cells.length - 1;
      while (j > i && !this.clear(anchor, cells[j])) j--;
      result.push(cells[j]);
      anchor = cells[j];
      i = j + 1;
    }
    return result;
  }
}

/** A* 开放表用的二叉最小堆 */
class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.items.length;
  }

  push(item: number, key: number) {
    const items = this.items;
    const keys = this.keys;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }

  pop(): number {
    const items = this.items;
    const keys = this.keys;
    const top = items[0];
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    if (items.length > 0) {
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && keys[r] < keys[l] ? r : l;
        if (keys[m] >= lastKey) break;
        items[i] = items[m];
        keys[i] = keys[m];
        i = m;
      }
      items[i] = lastItem;
      keys[i] = lastKey;
    }
    return top;
  }
}
