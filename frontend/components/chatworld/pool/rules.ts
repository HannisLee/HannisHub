/** 中式八球规则判定（在击球方浏览器执行，结果作为新的对局状态上传）。
 *
 *  - 开球：白球在开球区（开球线左侧）自由摆放。开球进黑 8 → 重新摆球，原开球方再开（若同时白球落袋则换对方开）；
 *    未进球且碰库的目标球少于 4 颗 → 开球不合法，换对方重新开球；开球白球落袋 → 犯规，对方在开球区摆放自由球。
 *    开球进的球不决定花色，进球（且无犯规）则继续击球。
 *  - 开放球局（未分花色）：可以先碰除黑 8 以外的任意球；第一颗合法打进的球决定击球方的花色（实色 1–7 / 花色 9–15）。
 *  - 犯规：白球落袋、白球没碰到球、先碰到的不是己方目标球、碰球后没有任何球进袋或碰库；犯规后对方获得自由球（全台任意摆放）。
 *  - 己方花色清台后目标为黑 8：合法打进黑 8 获胜；提前打进黑 8 或打进黑 8 时犯规判负。中式八球不需要报袋。 */

import type { PoolGame, PoolGroup, PoolSeat } from "../../../lib/lobby-pool";
import type { SimBall, SimResult } from "./physics";
import { HEAD_X, L, R, W, rackSpots, round1 } from "./table";

export function otherSeat(seat: PoolSeat): PoolSeat {
  return seat === "left" ? "right" : "left";
}

export function groupOf(n: number): PoolGroup | null {
  if (n >= 1 && n <= 7) return "solid";
  if (n >= 9 && n <= 15) return "stripe";
  return null;
}

export const GROUP_LABEL: Record<PoolGroup, string> = { solid: "实色球 1–7", stripe: "花色球 9–15" };

/** 随机三角框（与服务端 new_rack 规则相同）：黑 8 居中，底边两角一实一花 */
export function randomRack(): number[] {
  const shuffle = <T,>(list: T[]) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  const solids = shuffle([1, 2, 3, 4, 5, 6, 7]);
  const stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
  const corners = shuffle([solids.pop()!, stripes.pop()!]);
  const rest = shuffle([...solids, ...stripes]);
  return Array.from({ length: 15 }, (_, i) => (i === 4 ? 8 : i === 10 ? corners[0] : i === 14 ? corners[1] : rest.pop()!));
}

/** 开球时白球的默认位置（开球区中央偏左） */
export const BREAK_SPOT = { x: round1(HEAD_X - 120), y: W / 2 };

/** 对局状态中的球（未开球时按 rack 摆放） */
export function gameBalls(game: PoolGame): SimBall[] {
  if (game.balls) return game.balls.map(([n, x, y]) => ({ n, x, y }));
  const spots = rackSpots();
  return [{ n: 0, ...BREAK_SPOT }, ...game.rack.map((n, i) => ({ n, x: spots[i].x, y: spots[i].y }))];
}

/** 自由球摆放位置是否合法：在台面内、不与其他球重叠、开球区限制 */
export function validCueSpot(x: number, y: number, balls: SimBall[], kitchen: boolean): boolean {
  if (x < R || x > L - R || y < R || y > W - R) return false;
  if (kitchen && x > HEAD_X) return false;
  return balls.every(b => b.n === 0 || (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) >= (2 * R + 0.5) * (2 * R + 0.5));
}

/** 为落袋的白球找一个默认摆放点：从目标点开始螺旋搜索空位 */
export function freeSpot(balls: SimBall[], kitchen: boolean, prefer = BREAK_SPOT): { x: number; y: number } {
  for (let ring = 0; ring < 40; ring++) {
    const steps = Math.max(1, ring * 6);
    for (let k = 0; k < steps; k++) {
      const angle = (k / steps) * Math.PI * 2;
      const x = round1(prefer.x + Math.cos(angle) * ring * R);
      const y = round1(prefer.y + Math.sin(angle) * ring * R);
      if (validCueSpot(x, y, balls, kitchen)) return { x, y };
    }
  }
  return { x: R + 1, y: R + 1 };
}

/** 当前击球方的目标：开放球局为 null，己方花色清台后为 8 */
export function targetOf(game: PoolGame, seat: PoolSeat, balls: SimBall[]): PoolGroup | 8 | null {
  const group = game.groups[seat];
  if (!group) return null;
  return balls.some(b => groupOf(b.n) === group) ? group : 8;
}

function legalFirst(n: number, target: PoolGroup | 8 | null): boolean {
  if (n === 0) return false;
  if (target === 8) return n === 8;
  if (target) return groupOf(n) === target;
  return n !== 8;
}

function rerack(game: PoolGame, breaker: PoolSeat, msg: string, shots: number): PoolGame {
  return {
    ...game, rack: randomRack(), balls: null, turn: breaker, breaker, phase: "break",
    groups: { left: null, right: null }, hand: true, kitchen: true, winner: null, msg, shots,
    last: game.last,
  };
}

/** 一杆结束后的新对局状态 */
export function judge(game: PoolGame, before: SimBall[], result: SimResult): PoolGame {
  const seat = game.turn;
  const opp = otherSeat(seat);
  const shots = game.shots + 1;
  const pocketed = result.events.filter(e => e.kind === "pocket").map(e => (e.kind === "pocket" ? e.ball : -1));
  const objects = pocketed.filter(n => n !== 0);
  const cueIn = pocketed.includes(0);
  const eightIn = objects.includes(8);
  const firstHitEvent = result.events.find(e => e.kind === "hit" && (e.a === 0 || e.b === 0));
  const firstHit = firstHitEvent && firstHitEvent.kind === "hit" ? (firstHitEvent.a === 0 ? firstHitEvent.b : firstHitEvent.a) : null;
  const railAfter = firstHitEvent ? result.events.some(e => e.kind === "rail" && e.t >= firstHitEvent.t) : false;
  const target = game.phase === "break" ? null : targetOf(game, seat, before);
  const last = { pocketed, foul: null as string | null };

  let foul: string | null = null;
  if (cueIn) foul = "白球落袋";
  else if (firstHit === null) foul = "白球没有碰到任何球";
  else if (game.phase !== "break" && !legalFirst(firstHit, target)) {
    foul = target === 8 ? "没有先碰到黑 8" : target ? "先碰到了对方的球" : "开放球局不能先碰黑 8";
  } else if (objects.length === 0 && !railAfter) foul = "碰球后没有球进袋或碰库";
  last.foul = foul;

  // 留在台面上的球；白球落袋时为下一杆找一个默认位置（击球方可以再拖动）
  const final = result.final.map(b => ({ n: b.n, x: round1(b.x), y: round1(b.y) }));
  const withCue = (kitchen: boolean) => {
    if (final.some(b => b.n === 0)) return final;
    const spot = freeSpot(final, kitchen);
    return [{ n: 0, ...spot }, ...final];
  };
  const toTuple = (balls: SimBall[]) => balls.map(b => [b.n, b.x, b.y] as [number, number, number]);
  const base = { ...game, shots, last, winner: null };

  if (game.phase === "break") {
    if (eightIn) {
      return cueIn
        ? rerack({ ...game, last }, opp, "开球黑 8 进袋且白球落袋，换对方重新开球", shots)
        : rerack({ ...game, last }, seat, "开球打进黑 8，重新摆球，原开球方再次开球", shots);
    }
    if (cueIn) {
      return { ...base, balls: toTuple(withCue(true)), phase: "play", turn: opp, hand: true, kitchen: true,
        msg: "开球白球落袋，对方在开球区摆放自由球" };
    }
    const railBalls = new Set(result.events.filter(e => e.kind === "rail" && e.ball !== 0).map(e => (e.kind === "rail" ? e.ball : 0)));
    if (objects.length === 0 && railBalls.size < 4) {
      return rerack({ ...game, last: { ...last, foul: "开球不合法" } }, opp, "开球不合法（未进球且少于 4 颗球碰库），换对方重新开球", shots);
    }
    return objects.length > 0
      ? { ...base, balls: toTuple(final), phase: "play", turn: seat, hand: false, kitchen: false, msg: `开球进了 ${objects.length} 颗球，继续击球（仍为开放球局）` }
      : { ...base, balls: toTuple(final), phase: "play", turn: opp, hand: false, kitchen: false, msg: "开球未进球，轮到对方" };
  }

  if (eightIn) {
    const lose = foul !== null || target !== 8;
    const winner = lose ? opp : seat;
    const msg = lose ? (foul ? `${foul}，黑 8 进袋判负` : "提前打进黑 8，判负") : "打进黑 8，赢得本局！";
    return { ...base, balls: toTuple(final), phase: "over", winner, hand: false, kitchen: false, msg };
  }

  if (foul) {
    return { ...base, balls: toTuple(withCue(false)), turn: opp, hand: true, kitchen: false, msg: `犯规：${foul}，对方获得自由球` };
  }

  const groups = { ...game.groups };
  let assigned = "";
  if (!groups[seat]) {
    const first = objects.find(n => groupOf(n) !== null);
    const group = first !== undefined ? groupOf(first) : null;
    if (group) {
      groups[seat] = group;
      groups[opp] = group === "solid" ? "stripe" : "solid";
      assigned = `，定为${GROUP_LABEL[group]}`;
    }
  }
  const mine = groups[seat];
  const scored = mine ? objects.some(n => groupOf(n) === mine) : false;
  if (scored) {
    const left = mine ? final.filter(b => groupOf(b.n) === mine).length : 0;
    const tail = left === 0 ? "，己方球已清台，下一杆打黑 8" : "";
    return { ...base, groups, balls: toTuple(final), turn: seat, hand: false, kitchen: false, msg: `进球${assigned}，继续击球${tail}` };
  }
  return { ...base, groups, balls: toTuple(final), turn: opp, hand: false, kitchen: false,
    msg: objects.length > 0 ? "只打进了对方的球，轮到对方" : "未进球，轮到对方" };
}
