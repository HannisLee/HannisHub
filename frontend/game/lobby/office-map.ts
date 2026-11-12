/** 聊天大厅办公室地图：尺寸、地板/墙砖网格、家具与碰撞定义。
 *  坐标单位为像素（TILE=16），家具 x/y 为左上角。与渲染逻辑解耦，便于后续扩展多人/交互。 */

export const TILE = 16;
export const ROOM_COLS = 32;
export const ROOM_ROWS = 22;
export const WORLD_W = ROOM_COLS * TILE;
export const WORLD_H = ROOM_ROWS * TILE;

/** tiles_sheet.png 帧索引（0 起），-1 表示空 */
export const T = {
  empty: -1,
  wood: 0,
  carpet: 1,
  tile: 2,
  wallLower: 3,
  capTop: 4,
  capCenter: 5,
  capLeft: 6,
  capRight: 7,
  wallUpper: 8,
} as const;

/** 需要碰撞的墙砖索引 */
export const WALL_TILES = [T.wallLower, T.capTop, T.capCenter, T.capLeft, T.capRight, T.wallUpper];

export interface SolidBox {
  w: number;
  h: number;
  ox: number;
  oy: number;
}

export interface FurnitureDef {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 碰撞盒（相对左上角偏移）；缺省表示无碰撞 */
  solid?: SolidBox;
  /** 渲染深度；缺省按底边 y 排序（前后遮挡） */
  depth?: number;
}

/** 生成地板与墙砖网格：上墙 3 行（可容纳 48px 高的门），四周深色墙顶。 */
export function buildTileGrid(): number[][] {
  const grid: number[][] = [];
  for (let r = 0; r < ROOM_ROWS; r++) {
    const row: number[] = [];
    for (let c = 0; c < ROOM_COLS; c++) {
      let v: number = T.empty;
      if (r === 0) v = T.capTop;
      else if (r === 1) v = c === 0 || c === ROOM_COLS - 1 ? T.capCenter : T.wallUpper;
      else if (r === 2) v = c === 0 || c === ROOM_COLS - 1 ? T.capCenter : T.wallLower;
      else if (r === ROOM_ROWS - 1) v = c === 0 ? T.capLeft : c === ROOM_COLS - 1 ? T.capRight : T.capCenter;
      else if (c === 0 || c === ROOM_COLS - 1) v = T.capCenter;
      else v = T.wood;
      row.push(v);
    }
    grid.push(row);
  }
  // 休息区地毯
  for (let r = 16; r <= 19; r++) for (let c = 2; c <= 7; c++) grid[r][c] = T.carpet;
  return grid;
}

const px = (t: number) => t * TILE;

/** 6 个工位：2 排 × 3 列，桌+显示器+朝北的椅子（看到椅背）。 */
const DESKS: Array<[number, number]> = [
  [5, 5], [14, 5], [23, 5],
  [5, 11], [14, 11], [23, 11],
];

function buildFurniture(): FurnitureDef[] {
  const list: FurnitureDef[] = [];

  // 墙面挂件（固定低深度，无碰撞）
  const wall = (key: string, c: number, r: number, w: number, h: number) =>
    list.push({ key, x: px(c), y: px(r), w, h, depth: 2 });
  wall("window", 3, 0, 32, 32);
  wall("window", 8, 0, 32, 32);
  wall("window", 21, 0, 32, 32);
  wall("window", 26, 0, 32, 32);
  wall("door_wood", 16, 0, 16, 48);
  wall("whiteboard", 18, 0, 32, 32);
  wall("clock", 12, 1, 16, 16);

  // 工位与桌面小物
  DESKS.forEach(([c, r], i) => {
    const x = px(c);
    const y = px(r);
    const deskBottom = y + 32;
    list.push({ key: "desk_monitor", x, y, w: 32, h: 32, solid: { w: 32, h: 30, ox: 0, oy: 2 } });
    list.push({ key: "chair_office_up", x: x + 8, y: y + 32, w: 16, h: 32, solid: { w: 14, h: 22, ox: 1, oy: 10 } });
    // 桌面装饰：深度略高于桌子，保证坐在桌前的人物仍能盖住它们
    if (i === 0 || i === 5) list.push({ key: "mug", x: x + 21, y: y + 13, w: 16, h: 16, depth: deskBottom + 1 });
    if (i === 2 || i === 3) list.push({ key: "plant_small", x: x + 1, y: y + 12, w: 16, h: 16, depth: deskBottom + 1 });
  });

  // 靠墙家具
  const solid = (key: string, c: number, r: number, w: number, h: number, box: SolidBox) =>
    list.push({ key, x: px(c), y: px(r), w, h, solid: box });
  solid("bookshelf", 2, 3, 32, 48, { w: 32, h: 44, ox: 0, oy: 4 });
  solid("bookshelf", 28, 3, 32, 48, { w: 32, h: 44, ox: 0, oy: 4 });
  solid("filing_cabinet", 4, 3, 16, 32, { w: 16, h: 28, ox: 0, oy: 4 });
  solid("filing_cabinet", 27, 3, 16, 32, { w: 16, h: 28, ox: 0, oy: 4 });
  solid("water_dispenser", 25, 3, 16, 32, { w: 16, h: 28, ox: 0, oy: 4 });
  // 打印机放在右侧文件柜顶（装饰，深度高于柜体）
  list.push({ key: "printer", x: px(27), y: px(3) - 12, w: 16, h: 16, depth: px(3) + 32 + 1 });

  // 绿植
  solid("plant_big", 1, 3, 32, 32, { w: 26, h: 22, ox: 3, oy: 10 });
  solid("plant_big", 30, 3, 32, 32, { w: 26, h: 22, ox: 3, oy: 10 });
  solid("plant_big", 1, 18, 32, 32, { w: 26, h: 22, ox: 3, oy: 10 });
  solid("plant_big", 27, 18, 32, 32, { w: 26, h: 22, ox: 3, oy: 10 });

  // 休息区：沙发 + 茶几 + 桌面小物
  solid("sofa", 2, 16, 48, 32, { w: 48, h: 26, ox: 0, oy: 6 });
  solid("coffee_table", 2.5, 18.25, 32, 16, { w: 32, h: 12, ox: 0, oy: 4 });
  const tableBottom = px(18.25) + 16;
  list.push({ key: "laptop_open", x: px(2.5) + 2, y: tableBottom - 22, w: 16, h: 16, depth: tableBottom + 1 });
  list.push({ key: "mug", x: px(2.5) + 18, y: tableBottom - 18, w: 16, h: 16, depth: tableBottom + 1 });

  // 杂物
  solid("trash_bin", 8, 7, 16, 16, { w: 12, h: 12, ox: 2, oy: 4 });
  solid("trash_bin", 25, 13, 16, 16, { w: 12, h: 12, ox: 2, oy: 4 });
  solid("box_stack", 29, 18, 16, 32, { w: 16, h: 28, ox: 0, oy: 4 });

  return list;
}

export const FURNITURE = buildFurniture();

/** 出生点：入口（门）附近的过道 */
export const SPAWN = { x: px(16) + 8, y: px(4) + 6 };

/** 场景用到的全部物件贴图键 */
export const OBJECT_KEYS = [
  "desk_monitor", "chair_office_up", "bookshelf", "filing_cabinet", "printer",
  "water_dispenser", "plant_big", "plant_small", "sofa", "coffee_table",
  "laptop_open", "mug", "trash_bin", "box_stack", "window", "door_wood",
  "whiteboard", "clock",
];