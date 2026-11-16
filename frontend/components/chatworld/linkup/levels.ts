/** 连连看模式与关卡参数。
 *
 *  - 闯关：14×8 盘面（56 对），11 关一轮，每关一种变化方式（不变化 → 向下 → … → 左下右上）；
 *    一轮通关后进入下一轮，图案种类更多、时间更紧。超时即结束，成绩计入闯关排行。
 *  - 每日挑战：16×9 大盘面，以日期为种子，所有人同一天拿到同一个盘面和变化方式，成绩计入当日排行。
 *  - 休闲：自选盘面大小、变化方式与难度，不限时、道具不限量，不计成绩。
 *
 *  难度曲线的思路（不太简单也不太难）：图案种类越多，同种方块越少，可选的消除就越少；
 *  每对的平均用时从约 4.2 秒逐步收紧到 2.6 秒；生成器再按目标难度挑选开局可消对数合适的盘面。 */

import { SHIFTS, SHIFT_LABEL, hashSeed, type Shift } from "./board";
import { TILE_KINDS } from "./sprites";

export type LinkupMode = "campaign" | "daily" | "casual";

export const MODE_LABEL: Record<LinkupMode, string> = {
  campaign: "闯关模式",
  daily: "每日挑战",
  casual: "休闲模式",
};

export interface LevelConfig {
  mode: LinkupMode;
  /** 闯关的关卡序号（从 1 开始，跨轮累计）；其他模式为 1 */
  level: number;
  /** 第几轮（闯关），从 1 开始 */
  round: number;
  rows: number;
  cols: number;
  kinds: number;
  shift: Shift;
  difficulty: number;
  /** 限时（秒）；0 表示不限时 */
  time: number;
  seed: number;
  title: string;
  /** 每日挑战的日期（YYYY-MM-DD） */
  day?: string;
}

export const LEVELS_PER_ROUND = SHIFTS.length;

/** 每种变化方式的说明（关卡开始时显示） */
export const SHIFT_DESC: Record<Shift, string> = {
  none: "方块消除后保持原位",
  down: "消除后，上面的方块往下落",
  left: "消除后，右边的方块向左靠拢",
  up: "消除后，下面的方块向上靠拢",
  right: "消除后，左边的方块向右靠拢",
  "split-v": "上半部分向上、下半部分向下分开",
  "split-h": "左半部分向左、右半部分向右分开",
  "gather-v": "上下两半都向中间靠拢",
  "gather-h": "左右两半都向中间靠拢",
  "up-left-down-right": "上半部分向左、下半部分向右靠拢",
  "left-down-right-up": "左半部分向下、右半部分向上靠拢",
};

/** 每消除一对的基础分 */
export const PAIR_SCORE = 10;
/** 连击判定间隔（毫秒）：上一次消除后这段时间内再次消除即算连击 */
export const COMBO_WINDOW = 3500;
/** 过关时每剩 1 秒的奖励分 */
export const TIME_BONUS = 5;

/** 道具：开局数量、每过一关补充数量、上限 */
export const TOOLS = {
  hint: { start: 4, perLevel: 1, max: 9 },
  shuffle: { start: 3, perLevel: 1, max: 9 },
};

/** 每日挑战的道具（一局定胜负，不补充） */
export const DAILY_TOOLS = { hint: 3, shuffle: 2 };

/** 连击加分：第 n 次连击（n≥2）额外加 5×(n-1)，最多 +50 */
export function comboBonus(combo: number): number {
  return combo >= 2 ? Math.min(50, 5 * (combo - 1)) : 0;
}

export function campaignLevel(level: number, seed: number): LevelConfig {
  const round = Math.floor((level - 1) / LEVELS_PER_ROUND) + 1;
  const index = (level - 1) % LEVELS_PER_ROUND;
  const rows = 8;
  const cols = 14;
  const pairs = (rows * cols) / 2;
  // 第一轮 18 → 28 种，第二轮起 24 → 30 种
  const kinds = Math.min(30, round === 1 ? 18 + index : 24 + index + (round - 2) * 2);
  // 每对用时：第一轮 4.2 → 3.2 秒，之后每轮再收紧，最低 2.6 秒
  const perPair = Math.max(2.6, 4.2 - index * 0.1 - (round - 1) * 0.6);
  const difficulty = Math.min(1, 0.42 + index * 0.04 + (round - 1) * 0.2);
  const shift = SHIFTS[index];
  return {
    mode: "campaign", level, round, rows, cols, kinds, shift, difficulty,
    time: Math.round(pairs * perPair),
    seed: (seed + level * 7919) >>> 0,
    title: `第 ${level} 关 · ${SHIFT_LABEL[shift]}`,
  };
}

/** 每日挑战：日期决定盘面、变化方式（不含「不变化」）与图案组合 */
export function dailyLevel(day: string): LevelConfig {
  const seed = hashSeed(`linkup:${day}`);
  const shift = SHIFTS[1 + (seed % (SHIFTS.length - 1))];
  const rows = 9;
  const cols = 16;
  return {
    mode: "daily", level: 1, round: 1, rows, cols, kinds: 32, shift, difficulty: 0.7,
    time: Math.round(((rows * cols) / 2) * 3.4),
    seed,
    title: `每日挑战 · ${SHIFT_LABEL[shift]}`,
    day,
  };
}

export type CasualSize = "small" | "medium" | "large";
export type CasualLevel = "easy" | "normal" | "hard";

export const CASUAL_SIZES: Record<CasualSize, { rows: number; cols: number; label: string }> = {
  small: { rows: 7, cols: 12, label: "小 12×7" },
  medium: { rows: 8, cols: 14, label: "中 14×8" },
  large: { rows: 9, cols: 16, label: "大 16×9" },
};

export const CASUAL_LEVELS: Record<CasualLevel, { label: string; ratio: number; difficulty: number }> = {
  easy: { label: "简单", ratio: 0.32, difficulty: 0.3 },
  normal: { label: "普通", ratio: 0.42, difficulty: 0.55 },
  hard: { label: "困难", ratio: 0.5, difficulty: 0.9 },
};

export function casualLevel(size: CasualSize, level: CasualLevel, shift: Shift | "random", seed: number): LevelConfig {
  const { rows, cols } = CASUAL_SIZES[size];
  const pairs = (rows * cols) / 2;
  const chosen = shift === "random" ? SHIFTS[seed % SHIFTS.length] : shift;
  const config = CASUAL_LEVELS[level];
  return {
    mode: "casual", level: 1, round: 1, rows, cols,
    kinds: Math.min(TILE_KINDS, Math.round(pairs * config.ratio)),
    shift: chosen, difficulty: config.difficulty, time: 0, seed,
    title: `休闲 · ${SHIFT_LABEL[chosen]} · ${config.label}`,
  };
}
