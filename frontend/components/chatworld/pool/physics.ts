/** 台球二维物理模拟（确定性）：固定步长，只用加减乘除与 Math.sqrt（IEEE 754 精确舍入），
 *  同一组输入在任何浏览器得到完全相同的结果，因此双方只需同步击球参数即可回放同一杆。
 *
 *  模型：
 *  - 每个球有线速度 v 与「滚动速度」s（= 角速度 × 半径，滚动时 s = v）。u = v − s 为与台呢的接触点滑动速度：
 *    滑动阶段摩擦使 v 减小、s 增大（dv = −μs·g·û，ds = 2.5·μs·g·û），直到纯滚动；之后按滚动阻力减速。
 *    高杆（s 与 v 同向更大）、低杆（s 反向）在撞球后自然产生跟进 / 拉回。
 *  - 侧旋 w（右塞为正）只在吃库时改变反弹方向，并随时间衰减。
 *  - 球与球：等质量弹性碰撞（恢复系数 0.94），只交换法向速度，旋转不变。
 *  - 库边与袋角：线段碰撞（含端点圆角），恢复系数 0.78；球心进入袋口判定圆即落袋。 */

import { POCKETS, R, SEGMENTS } from "./table";

export const DT = 1 / 1200;
const FRAME_STEPS = 20; // 每 20 步（1/60 秒）记录一帧
const MAX_STEPS = 1200 * 40;
const SLIDE = 0.12 * 9810; // 滑动摩擦 μs·g（略低于真实台呢，让低杆、高杆在中距离上更明显）
const ROLL = 0.018 * 9810; // 滚动阻力 μr·g
const SPIN_DECAY = 1000; // 侧旋衰减（毫米/秒²）
const BALL_E = 0.94;
const RAIL_E = 0.78;
const ENGLISH = 0.15;
const D2 = (2 * R) * (2 * R);

export interface SimBall {
  n: number;
  x: number;
  y: number;
}

export interface ShotInput {
  vx: number;
  vy: number;
  sx: number;
  sy: number;
  w: number;
}

export type SimEvent =
  | { t: number; kind: "hit"; a: number; b: number; speed: number }
  | { t: number; kind: "rail"; ball: number; speed: number }
  | { t: number; kind: "pocket"; ball: number; pocket: number };

export interface SimResult {
  /** 每帧 16 个球的坐标（x, y 交替，下标为球号），不在台面上的球为 NaN */
  frames: Float32Array[];
  events: SimEvent[];
  /** 停稳后仍在台面上的球 */
  final: SimBall[];
  duration: number;
}

interface Body {
  n: number;
  on: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  sx: number;
  sy: number;
  w: number;
}

function snapshot(bodies: Body[]): Float32Array {
  const frame = new Float32Array(32).fill(NaN);
  for (const b of bodies) {
    if (!b.on) continue;
    frame[b.n * 2] = b.x;
    frame[b.n * 2 + 1] = b.y;
  }
  return frame;
}

function moving(b: Body): boolean {
  return b.vx !== 0 || b.vy !== 0 || b.sx !== 0 || b.sy !== 0;
}

/** 台面摩擦：滑动 → 滚动 → 停止 */
function friction(b: Body) {
  const ux = b.vx - b.sx;
  const uy = b.vy - b.sy;
  const u = Math.sqrt(ux * ux + uy * uy);
  if (u > 1e-6) {
    const step = SLIDE * DT;
    if (3.5 * step >= u) {
      // 本步内达到纯滚动
      const k = u / 3.5;
      b.vx -= (ux / u) * k;
      b.vy -= (uy / u) * k;
      b.sx = b.vx;
      b.sy = b.vy;
    } else {
      b.vx -= (ux / u) * step;
      b.vy -= (uy / u) * step;
      b.sx += (ux / u) * step * 2.5;
      b.sy += (uy / u) * step * 2.5;
    }
  } else {
    const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    const step = ROLL * DT;
    if (v <= step) {
      b.vx = 0;
      b.vy = 0;
    } else {
      b.vx -= (b.vx / v) * step;
      b.vy -= (b.vy / v) * step;
    }
    b.sx = b.vx;
    b.sy = b.vy;
  }
  if (b.w !== 0) {
    const decay = SPIN_DECAY * DT;
    b.w = b.w > decay ? b.w - decay : b.w < -decay ? b.w + decay : 0;
  }
}

/** 模拟一杆：balls 为击球前台面上的球（白球已摆到击球位置），返回逐帧轨迹、事件与最终位置 */
export function simulate(balls: SimBall[], shot: ShotInput): SimResult {
  const bodies: Body[] = balls
    .map(b => ({ n: b.n, on: true, x: b.x, y: b.y, vx: 0, vy: 0, sx: 0, sy: 0, w: 0 }))
    .sort((a, b) => a.n - b.n);
  const cue = bodies.find(b => b.n === 0);
  if (cue) {
    cue.vx = shot.vx;
    cue.vy = shot.vy;
    cue.sx = shot.sx;
    cue.sy = shot.sy;
    cue.w = shot.w;
  }
  const frames: Float32Array[] = [snapshot(bodies)];
  const events: SimEvent[] = [];
  // 正在接触的球对 / 球与库边，避免同一次接触重复记录声音事件
  const touching = new Set<number>();
  let step = 0;
  for (; step < MAX_STEPS; step++) {
    const t = step * DT;
    let any = false;
    for (const b of bodies) {
      if (!b.on || !moving(b)) continue;
      any = true;
      friction(b);
      b.x += b.vx * DT;
      b.y += b.vy * DT;
    }
    if (!any) break;

    // 球与球
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (!a.on) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (!b.on) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const key = a.n * 16 + b.n;
        if (d2 >= D2) {
          touching.delete(key);
          continue;
        }
        if (!moving(a) && !moving(b)) continue;
        const d = Math.sqrt(d2) || 1e-9;
        const nx = dx / d;
        const ny = dy / d;
        // 推开重叠部分（各退一半）
        const push = (2 * R - d) / 2;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (rel <= 0) continue;
        const impulse = ((1 + BALL_E) / 2) * rel;
        a.vx -= impulse * nx;
        a.vy -= impulse * ny;
        b.vx += impulse * nx;
        b.vy += impulse * ny;
        if (!touching.has(key)) {
          touching.add(key);
          events.push({ t, kind: "hit", a: a.n, b: b.n, speed: rel });
        }
      }
    }

    // 库边、袋角与落袋
    for (const b of bodies) {
      if (!b.on || !moving(b)) continue;
      for (let s = 0; s < SEGMENTS.length; s++) {
        const seg = SEGMENTS[s];
        const ex = seg.bx - seg.ax;
        const ey = seg.by - seg.ay;
        const len2 = ex * ex + ey * ey;
        let k = ((b.x - seg.ax) * ex + (b.y - seg.ay) * ey) / len2;
        k = k < 0 ? 0 : k > 1 ? 1 : k;
        const cx = seg.ax + ex * k;
        const cy = seg.ay + ey * k;
        const dx = b.x - cx;
        const dy = b.y - cy;
        const d2 = dx * dx + dy * dy;
        const key = 1000 + b.n * 100 + s;
        if (d2 >= R * R) {
          touching.delete(key);
          continue;
        }
        const d = Math.sqrt(d2) || 1e-9;
        const nx = dx / d;
        const ny = dy / d;
        b.x = cx + nx * R;
        b.y = cy + ny * R;
        const vn = b.vx * nx + b.vy * ny;
        if (vn >= 0) continue;
        const tx = -ny;
        const ty = nx;
        const vt = b.vx * tx + b.vy * ty;
        // 侧旋：沿 (ny, −nx) 方向（即 −t）推动，幅度不超过法向速度的 0.6 倍
        let english = -ENGLISH * b.w;
        const cap = -0.6 * vn;
        english = english > cap ? cap : english < -cap ? -cap : english;
        const nvt = vt * 0.97 + english;
        const nvn = -vn * RAIL_E;
        b.vx = nx * nvn + tx * nvt;
        b.vy = ny * nvn + ty * nvt;
        // 滚动旋转：法向分量大部分被库边吃掉
        const sn = b.sx * nx + b.sy * ny;
        const st = b.sx * tx + b.sy * ty;
        const nsn = -0.3 * sn;
        b.sx = nx * nsn + tx * st;
        b.sy = ny * nsn + ty * st;
        b.w *= 0.5;
        if (!touching.has(key)) {
          touching.add(key);
          events.push({ t, kind: "rail", ball: b.n, speed: -vn });
        }
      }
      for (let p = 0; p < POCKETS.length; p++) {
        const pocket = POCKETS[p];
        const dx = b.x - pocket.x;
        const dy = b.y - pocket.y;
        if (dx * dx + dy * dy < pocket.r * pocket.r) {
          b.on = false;
          b.vx = b.vy = b.sx = b.sy = b.w = 0;
          events.push({ t, kind: "pocket", ball: b.n, pocket: p });
          break;
        }
      }
    }

    // 兜底：极端情况下穿出台面的球按最近的袋口落袋
    for (const b of bodies) {
      if (!b.on) continue;
      if (b.x < -R * 2 || b.x > 2540 + R * 2 || b.y < -R * 2 || b.y > 1270 + R * 2) {
        let best = 0;
        let bestD = Infinity;
        POCKETS.forEach((pocket, p) => {
          const d = (pocket.x - b.x) * (pocket.x - b.x) + (pocket.y - b.y) * (pocket.y - b.y);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        });
        b.on = false;
        events.push({ t, kind: "pocket", ball: b.n, pocket: best });
      }
    }

    if ((step + 1) % FRAME_STEPS === 0) frames.push(snapshot(bodies));
  }
  frames.push(snapshot(bodies));
  return {
    frames,
    events,
    final: bodies.filter(b => b.on).map(b => ({ n: b.n, x: b.x, y: b.y })),
    duration: step * DT,
  };
}

/** 由瞄准方向、力度与击球点计算击球参数（已取一位小数，双方用同一组数值模拟）。
 *  power 0–1；spinX 左右塞、spinY 高低杆，取值 −1–1（高低杆击球点偏离球心至多 0.6 个半径，左右塞 0.5 个半径） */
export function makeShot(dirX: number, dirY: number, power: number, spinX: number, spinY: number): ShotInput {
  const speed = 250 + (8000 - 250) * Math.pow(Math.max(0, Math.min(1, power)), 1.8);
  const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
  const dx = dirX / len;
  const dy = dirY / len;
  const b = 0.6 * Math.max(-1, Math.min(1, spinY));
  const a = 0.5 * Math.max(-1, Math.min(1, spinX));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    vx: r1(speed * dx),
    vy: r1(speed * dy),
    sx: r1(2.5 * b * speed * dx),
    sy: r1(2.5 * b * speed * dy),
    w: r1(2.5 * a * speed),
  };
}
