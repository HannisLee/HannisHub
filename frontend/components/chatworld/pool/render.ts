/** 球台与球的 Canvas 绘制。
 *  - 球逐像素着色：每个球有一个三维朝向矩阵，随移动距离滚动；按法线换算到球的局部坐标决定颜色
 *    （实色球、花色球的色带、两极的白色号码圆、白球上的红点），再叠加漫反射与高光，看起来是真的在滚。
 *  - 号码文字按号码圆的朝向压扁绘制，转到背面时隐藏。 */

import { CUSHION, CUSHIONS, FOOT_X, HEAD_X, L, POCKETS, R, W } from "./table";

/** 木质台边宽度（库边以外） */
export const RAIL = 120;
/** 画布显示的世界范围 */
export const VIEW = { x: -CUSHION - RAIL, y: -CUSHION - RAIL, w: L + 2 * (CUSHION + RAIL), h: W + 2 * (CUSHION + RAIL) };

/** 标准颜色：1 黄、2 蓝、3 红、4 紫、5 橙、6 绿、7 酱红、8 黑；9–15 为对应颜色的花色球 */
const BALL_COLORS: [number, number, number][] = [
  [244, 241, 232], [238, 185, 30], [31, 78, 170], [206, 44, 40], [96, 50, 140], [236, 112, 32], [26, 120, 72], [128, 36, 36],
  [24, 24, 24],
];

export function ballColor(n: number): [number, number, number] {
  if (n === 0) return BALL_COLORS[0];
  if (n === 8) return BALL_COLORS[8];
  return BALL_COLORS[n > 8 ? n - 8 : n];
}

export function ballCss(n: number): string {
  const [r, g, b] = ballColor(n);
  return `rgb(${r}, ${g}, ${b})`;
}

/** 3×3 旋转矩阵（行主序），把球的局部坐标转到世界坐标；世界 z 轴朝向观察者 */
export type Mat3 = number[];

export function randomOrientation(): Mat3 {
  // 号码大体朝上，随机倾斜一点，摆好的球看上去不呆板
  const angle = (Math.random() - 0.5) * 1.2;
  const axisAngle = Math.random() * Math.PI * 2;
  let m = rotation(Math.cos(axisAngle), Math.sin(axisAngle), 0, angle);
  m = multiply(rotation(0, 0, 1, Math.random() * Math.PI * 2), m);
  return m;
}

function rotation(kx: number, ky: number, kz: number, angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * kx * kx + c, t * kx * ky - s * kz, t * kx * kz + s * ky,
    t * kx * ky + s * kz, t * ky * ky + c, t * ky * kz - s * kx,
    t * kx * kz - s * ky, t * ky * kz + s * kx, t * kz * kz + c,
  ];
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return out;
}

/** 球在台面上移动 (dx, dy) 后的朝向：绕 (−dy, dx, 0) 轴转过 距离/R */
export function roll(m: Mat3, dx: number, dy: number): Mat3 {
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-3) return m;
  return multiply(rotation(-dy / d, dx / d, 0, d / R), m);
}

const LIGHT = (() => {
  const v = [-0.45, -0.55, 0.7];
  const n = Math.hypot(v[0], v[1], v[2]);
  return v.map(c => c / n);
})();
const HALF = (() => {
  const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1];
  const n = Math.hypot(v[0], v[1], v[2]);
  return v.map(c => c / n);
})();

/** 白球上的六个红点（局部坐标轴方向），转动时能看出旋转 */
const CUE_DOTS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** 逐像素绘制一个球到离屏画布（尺寸 size×size，球半径 size/2 − 1） */
export function paintBall(canvas: HTMLCanvasElement, n: number, m: Mat3, size: number) {
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const radius = size / 2 - 1;
  const c = size / 2;
  const [br, bg, bb] = ballColor(n);
  const white: [number, number, number] = [246, 243, 234];
  const stripe = n > 8;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const nx = (px + 0.5 - c) / radius;
      const ny = (py + 0.5 - c) / radius;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1.08) continue;
      const edge = Math.max(0, Math.min(1, (1 - Math.sqrt(r2)) * radius + 0.6));
      if (edge <= 0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - r2));
      // 世界法线 → 局部坐标（乘以转置）
      const lx = m[0] * nx + m[3] * ny + m[6] * nz;
      const ly = m[1] * nx + m[4] * ny + m[7] * nz;
      const lz = m[2] * nx + m[5] * ny + m[8] * nz;
      let col: [number, number, number];
      if (n === 0) {
        col = white;
        for (const dot of CUE_DOTS) {
          if (lx * dot[0] + ly * dot[1] + lz * dot[2] > 0.975) {
            col = [196, 48, 44];
            break;
          }
        }
      } else if (Math.abs(lz) > 0.8) {
        col = white;
      } else if (stripe) {
        col = Math.abs(lz) < 0.5 ? [br, bg, bb] : white;
      } else {
        col = [br, bg, bb];
      }
      const diffuse = 0.42 + 0.58 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      const h = Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]);
      const spec = Math.pow(h, 60) * 0.85 + Math.pow(h, 8) * 0.08;
      const i = (py * size + px) * 4;
      data[i] = Math.min(255, col[0] * diffuse + spec * 255);
      data[i + 1] = Math.min(255, col[1] * diffuse + spec * 255);
      data[i + 2] = Math.min(255, col[2] * diffuse + spec * 255);
      data[i + 3] = edge * 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** 在号码圆朝向观察者时画号码（scale 为 毫米→像素） */
export function drawNumber(ctx: CanvasRenderingContext2D, n: number, m: Mat3, x: number, y: number, radius: number) {
  if (n === 0) return;
  for (const sign of [1, -1]) {
    const px = m[2] * sign;
    const py = m[5] * sign;
    const pz = m[8] * sign;
    if (pz < 0.3) continue;
    const cx = x + px * radius * 0.98;
    const cy = y + py * radius * 0.98;
    const angle = Math.atan2(py, px);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(pz, 1);
    ctx.rotate(-angle);
    ctx.globalAlpha = Math.min(1, (pz - 0.3) * 4);
    ctx.fillStyle = "#1c1b19";
    ctx.font = `600 ${radius * 0.62}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), 0, radius * 0.04);
    ctx.restore();
  }
}

/** 球台：木边、库边、台呢、袋口、星点（菱形标记）、开球线与置球点 */
export function drawTable(ctx: CanvasRenderingContext2D) {
  const outer = CUSHION + RAIL;
  // 木质台边
  ctx.fillStyle = "#4a2c1c";
  roundRect(ctx, -outer, -outer, L + outer * 2, W + outer * 2, 70);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 220, 180, 0.12)";
  ctx.lineWidth = 6;
  roundRect(ctx, -outer + 18, -outer + 18, L + (outer - 18) * 2, W + (outer - 18) * 2, 52);
  ctx.stroke();
  // 台呢（含库边下方）
  ctx.fillStyle = "#1e6b52";
  ctx.fillRect(-CUSHION, -CUSHION, L + CUSHION * 2, W + CUSHION * 2);
  // 台呢上的微弱暗角
  const vignette = ctx.createRadialGradient(L / 2, W / 2, W * 0.3, L / 2, W / 2, L * 0.62);
  vignette.addColorStop(0, "rgba(255, 255, 255, 0.04)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.22)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, L, W);
  // 袋口
  for (const p of POCKETS) {
    ctx.fillStyle = "#3a2316";
    ctx.beginPath();
    ctx.arc(p.hx, p.hy, p.hr + 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0b0a09";
    ctx.beginPath();
    ctx.arc(p.hx, p.hy, p.hr, 0, Math.PI * 2);
    ctx.fill();
  }
  // 库边（颜色比台呢稍深，带一条内沿高光）
  for (const c of CUSHIONS) {
    ctx.fillStyle = "#17573f";
    ctx.beginPath();
    ctx.moveTo(c.ja.x, c.ja.y);
    ctx.lineTo(c.a.x, c.a.y);
    ctx.lineTo(c.b.x, c.b.y);
    ctx.lineTo(c.jb.x, c.jb.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(c.a.x, c.a.y);
    ctx.lineTo(c.b.x, c.b.y);
    ctx.stroke();
  }
  // 星点：长边每 1/8、短边每 1/4
  ctx.fillStyle = "#e9dcc0";
  const mid = CUSHION + RAIL / 2;
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue;
    diamond(ctx, (L / 8) * i, -mid);
    diamond(ctx, (L / 8) * i, W + mid);
  }
  for (let i = 1; i < 4; i++) {
    diamond(ctx, -mid, (W / 4) * i);
    diamond(ctx, L + mid, (W / 4) * i);
  }
  // 开球线、置球点
  ctx.strokeStyle = "rgba(255, 255, 255, 0.13)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(HEAD_X, 0);
  ctx.lineTo(HEAD_X, W);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
  for (const x of [HEAD_X, FOOT_X]) {
    ctx.beginPath();
    ctx.arc(x, W / 2, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - 13);
  ctx.lineTo(x + 8, y);
  ctx.lineTo(x, y + 13);
  ctx.lineTo(x - 8, y);
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 球杆：tip 为杆头位置，(dx, dy) 为击球方向；杆身向后延伸 */
export function drawCue(ctx: CanvasRenderingContext2D, tipX: number, tipY: number, dx: number, dy: number, alpha = 1) {
  const length = 1450;
  const angle = Math.atan2(dy, dx);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(tipX, tipY);
  ctx.rotate(angle + Math.PI);
  // 投影
  ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
  taper(ctx, 18, length, 6, 15, 22);
  // 杆身：皮头、白色先角、枫木前节、接牙、深色后把
  ctx.fillStyle = "#5c7fa8";
  taper(ctx, 0, 10, 6, 6.1, 0);
  ctx.fillStyle = "#f2ede1";
  taper(ctx, 10, 32, 6.1, 6.4, 0);
  ctx.fillStyle = "#e0c58f";
  taper(ctx, 32, 760, 6.4, 10.5, 0);
  ctx.fillStyle = "#c9b48a";
  taper(ctx, 760, 790, 10.5, 11, 0);
  ctx.fillStyle = "#3b2116";
  taper(ctx, 790, length, 11, 15, 0);
  ctx.fillStyle = "#d97757";
  taper(ctx, 1000, 1030, 12.2, 12.6, 0);
  ctx.restore();
}

function taper(ctx: CanvasRenderingContext2D, from: number, to: number, w0: number, w1: number, offset: number) {
  ctx.beginPath();
  ctx.moveTo(from + offset, -w0 + offset);
  ctx.lineTo(to + offset, -w1 + offset);
  ctx.lineTo(to + offset, w1 + offset);
  ctx.lineTo(from + offset, w0 + offset);
  ctx.closePath();
  ctx.fill();
}
