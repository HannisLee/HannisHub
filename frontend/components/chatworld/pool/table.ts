/** 中式八球球台几何（单位毫米，坐标原点为台面左上角库边内沿，x 向右、y 向下）。
 *  台面内沿 2540×1270（九尺中式台），球径 57.15。开球区在左侧四分之一（开球线 x = L/4），置球点在右侧四分之一。
 *  服务端 chatworld/lobby_pool.py 的 TABLE_LENGTH / TABLE_WIDTH 与这里一致。 */

export const L = 2540;
export const W = 1270;
export const R = 28.575;
/** 开球线 */
export const HEAD_X = L / 4;
/** 置球点（三角框顶点） */
export const FOOT_X = (L * 3) / 4;

export interface Vec {
  x: number;
  y: number;
}

/** 库边线段（碰撞用）：库边内沿与袋口两侧的袋角 */
export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** 一条库边：a、b 为内沿两端（袋角尖），ja、jb 为袋角向袋内延伸的终点 */
export interface Cushion {
  a: Vec;
  b: Vec;
  ja: Vec;
  jb: Vec;
}

export interface Pocket {
  /** 落袋判定圆：球心进入即入袋 */
  x: number;
  y: number;
  r: number;
  /** 画面上袋口洞的圆心与半径 */
  hx: number;
  hy: number;
  hr: number;
}

/** 底袋袋角尖到球台角的距离（袋口宽约 99mm）；中袋袋口半宽 */
const CORNER = 70;
const MIDDLE = 50;
/** 库边厚度（袋角向袋内延伸的深度） */
export const CUSHION = 44;

const h = L / 2;

export const CUSHIONS: Cushion[] = [
  // 上库左段、右段
  { a: { x: CORNER, y: 0 }, b: { x: h - MIDDLE, y: 0 }, ja: { x: CORNER - 34, y: -CUSHION }, jb: { x: h - MIDDLE + 7, y: -CUSHION } },
  { a: { x: h + MIDDLE, y: 0 }, b: { x: L - CORNER, y: 0 }, ja: { x: h + MIDDLE - 7, y: -CUSHION }, jb: { x: L - CORNER + 34, y: -CUSHION } },
  // 下库左段、右段
  { a: { x: CORNER, y: W }, b: { x: h - MIDDLE, y: W }, ja: { x: CORNER - 34, y: W + CUSHION }, jb: { x: h - MIDDLE + 7, y: W + CUSHION } },
  { a: { x: h + MIDDLE, y: W }, b: { x: L - CORNER, y: W }, ja: { x: h + MIDDLE - 7, y: W + CUSHION }, jb: { x: L - CORNER + 34, y: W + CUSHION } },
  // 左库、右库
  { a: { x: 0, y: CORNER }, b: { x: 0, y: W - CORNER }, ja: { x: -CUSHION, y: CORNER - 34 }, jb: { x: -CUSHION, y: W - CORNER + 34 } },
  { a: { x: L, y: CORNER }, b: { x: L, y: W - CORNER }, ja: { x: L + CUSHION, y: CORNER - 34 }, jb: { x: L + CUSHION, y: W - CORNER + 34 } },
];

export const SEGMENTS: Segment[] = CUSHIONS.flatMap(c => [
  { ax: c.ja.x, ay: c.ja.y, bx: c.a.x, by: c.a.y },
  { ax: c.a.x, ay: c.a.y, bx: c.b.x, by: c.b.y },
  { ax: c.b.x, ay: c.b.y, bx: c.jb.x, by: c.jb.y },
]);

const cornerIn = 11;
const cornerHole = -10;
export const POCKETS: Pocket[] = [
  { x: cornerIn, y: cornerIn, r: 31, hx: cornerHole, hy: cornerHole, hr: 60 },
  { x: h, y: -30, r: 27, hx: h, hy: -38, hr: 54 },
  { x: L - cornerIn, y: cornerIn, r: 31, hx: L - cornerHole, hy: cornerHole, hr: 60 },
  { x: cornerIn, y: W - cornerIn, r: 31, hx: cornerHole, hy: W - cornerHole, hr: 60 },
  { x: h, y: W + 30, r: 27, hx: h, hy: W + 38, hr: 54 },
  { x: L - cornerIn, y: W - cornerIn, r: 31, hx: L - cornerHole, hy: W - cornerHole, hr: 60 },
];

/** 三角框 15 个位置的球心（第 0 个为置球点上的顶点，逐行向右展开）。坐标保留一位小数，保证各端一致 */
export function rackSpots(): Vec[] {
  const gap = 2 * R + 0.2;
  const dx = (gap * Math.sqrt(3)) / 2;
  const spots: Vec[] = [];
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      spots.push({ x: round1(FOOT_X + row * dx), y: round1(W / 2 + (j - row / 2) * gap) });
    }
  }
  return spots;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
