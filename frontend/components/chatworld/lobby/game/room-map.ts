/** 聊天大厅客厅地图：尺寸、地板/墙砖网格、家具与碰撞定义。
 *  坐标单位为像素（TILE=16），家具 x/y 为左上角。素材来自付费包 Limezu Modern Interiors（16x16），
 *  墙壳砖块取自包内官方预拼房间 Condominium_Design 的同套裁剪，保证透视与收边连贯。 */

export const TILE = 16;
export const ROOM_COLS = 32;
export const ROOM_ROWS = 22;
export const WORLD_W = ROOM_COLS * TILE;
export const WORLD_H = ROOM_ROWS * TILE;

/** tiles_sheet.png 帧索引（0 起） */
export const T = {
  floor: 0,
  floorAlt: 1,
  capTop: 2,
  wallFace: 3,
  capTL: 4,
  capTR: 5,
  faceTL: 6,
  faceTR: 7,
  leftUpper: 8,
  leftInnerUpper: 9,
  rightInnerUpper: 10,
  rightUpper: 11,
  leftMid: 12,
  leftInnerMid: 13,
  rightInnerMid: 14,
  rightMid: 15,
  leftLower: 16,
  leftInnerLower: 17,
  rightInnerLower: 18,
  rightLower: 19,
  leftWall: 20,
  rightWall: 21,
  bottomLeft: 22,
  bottom: 23,
  bottomRight: 24,
} as const;

/** 需要碰撞的墙砖索引（地板除外全部参与碰撞） */
export const WALL_TILES = [
  T.capTop, T.wallFace, T.capTL, T.capTR, T.faceTL, T.faceTR,
  T.leftUpper, T.leftInnerUpper, T.rightInnerUpper, T.rightUpper,
  T.leftMid, T.leftInnerMid, T.rightInnerMid, T.rightMid,
  T.leftLower, T.leftInnerLower, T.rightInnerLower, T.rightLower,
  T.leftWall, T.rightWall, T.bottomLeft, T.bottom, T.bottomRight,
];

export interface SolidBox { w: number; h: number; ox: number; oy: number; }

export interface FurnitureDef {
  key: string; x: number; y: number; w: number; h: number;
  /** 碰撞盒（相对左上角偏移）；缺省表示无碰撞 */
  solid?: SolidBox;
  /** 渲染深度；缺省按底边 y 排序（前后遮挡） */
  depth?: number;
}

/** 生成地板与墙砖网格：上墙 2 行（容纳 32px 高的门与挂钟），
 *  侧墙顶部 3 行带透视斜肩，底部 1 行收边。 */
export function buildTileGrid(): number[][] {
  const grid: number[][] = [];
  for (let r = 0; r < ROOM_ROWS; r++) {
    const row: number[] = [];
    for (let c = 0; c < ROOM_COLS; c++) {
      const last = ROOM_COLS - 1;
      let v: number = T.floor;
      if (r === 0) v = c === 0 ? T.capTL : c === last ? T.capTR : T.capTop;
      else if (r === 1) v = c === 0 ? T.faceTL : c === last ? T.faceTR : T.wallFace;
      else if (r === 2) v = c === 0 ? T.leftUpper : c === 1 ? T.leftInnerUpper
        : c === last ? T.rightUpper : c === last - 1 ? T.rightInnerUpper : T.floor;
      else if (r === 3) v = c === 0 ? T.leftMid : c === 1 ? T.leftInnerMid
        : c === last ? T.rightMid : c === last - 1 ? T.rightInnerMid : T.floor;
      else if (r === 4) v = c === 0 ? T.leftLower : c === 1 ? T.leftInnerLower
        : c === last ? T.rightLower : c === last - 1 ? T.rightInnerLower : T.floor;
      else if (r === ROOM_ROWS - 1) v = c === 0 ? T.bottomLeft : c === last ? T.bottomRight : T.bottom;
      else if (c === 0) v = T.leftWall;
      else if (c === last) v = T.rightWall;
      else if ((r * 7 + c * 13) % 17 === 0) v = T.floorAlt;
      row.push(v);
    }
    grid.push(row);
  }
  return grid;
}

const px = (t: number) => t * TILE;

function buildFurniture(): FurnitureDef[] {
  const list: FurnitureDef[] = [];
  const solid = (key: string, x: number, y: number, w: number, h: number, box: SolidBox) =>
    list.push({ key, x, y, w, h, solid: box });

  // 墙面挂件（固定低深度，无碰撞）：底边贴在上墙脚
  list.push({ key: "wall_art", x: px(5), y: px(0), w: 16, h: 32, depth: 2 });
  list.push({ key: "wall_art", x: px(25), y: px(0), w: 16, h: 32, depth: 2 });

  // 靠上墙的书柜与储物柜
  solid("bookshelf", px(3), px(2), 32, 48, { w: 32, h: 40, ox: 0, oy: 8 });
  solid("bookshelf", px(27), px(2), 32, 48, { w: 32, h: 40, ox: 0, oy: 8 });
  solid("cabinet", px(20), px(2), 32, 48, { w: 32, h: 40, ox: 0, oy: 8 });

  // 右侧工作角：两张电脑桌 + 朝北的椅子
  for (const r of [6, 11]) {
    const x = px(26);
    const y = px(r);
    solid("desk_computer", x, y, 32, 48, { w: 32, h: 40, ox: 0, oy: 8 });
    solid("chair", x + 8, y + 48, 16, 32, { w: 14, h: 20, ox: 1, oy: 12 });
  }
  solid("water_cooler", px(29), px(6), 16, 32, { w: 14, h: 24, ox: 1, oy: 8 });

  // 左下休息区：沙发 + 单人椅 + 茶几 + 落地灯
  solid("sofa", px(4), px(13), 32, 16, { w: 32, h: 12, ox: 0, oy: 4 });
  solid("armchair", px(8), px(15), 32, 32, { w: 28, h: 24, ox: 2, oy: 8 });
  solid("coffee_table", px(4), px(15), 32, 32, { w: 32, h: 24, ox: 0, oy: 8 });
  const tableBottom = px(15) + 32;
  list.push({ key: "plant_small", x: px(4) + 16, y: tableBottom - 36, w: 16, h: 32, depth: tableBottom + 1 });
  solid("floor_lamp", px(2), px(13), 16, 48, { w: 12, h: 10, ox: 2, oy: 38 });

  // 中央区域毯：猫睡在其上，作为开阔地面的视觉焦点
  list.push({ key: "rug", x: px(13) + 8, y: px(10), w: 48, h: 32, depth: 1 });

  // 右下影音角：电视柜 + 电视（电视为动画 sprite，深度高于柜体）
  solid("tv_bench", px(24), px(18), 32, 32, { w: 32, h: 24, ox: 0, oy: 8 });
  solid("plant_small", px(22), px(18), 16, 32, { w: 12, h: 10, ox: 2, oy: 22 });

  // 角落绿植
  solid("plant_big", px(1), px(17), 32, 48, { w: 26, h: 20, ox: 3, oy: 28 });
  solid("plant_big", px(29), px(17), 32, 48, { w: 26, h: 20, ox: 3, oy: 28 });

  return list;
}

export const FURNITURE = buildFurniture();

/** 出生点：入口（门）附近的过道 */
export const SPAWN = { x: px(16) + 8, y: px(3) + 6 };

/** 场景用到的静态物件贴图键 */
export const OBJECT_KEYS = [
  "sofa", "armchair", "coffee_table", "bookshelf", "cabinet", "plant_big",
  "plant_small", "floor_lamp", "desk_computer", "chair", "tv_bench",
  "water_cooler", "rug", "wall_art",
];

/** 动画物件：贴图键、帧尺寸与帧率（帧数由贴图宽度推导；猫 48×16、电视 32×32 为素材原生帧宽） */
export const ANIMATED_OBJECTS = [
  { key: "tv", frameWidth: 32, frameHeight: 32, frameRate: 8 },
  { key: "clock", frameWidth: 16, frameHeight: 32, frameRate: 2 },
  { key: "cat", frameWidth: 48, frameHeight: 16, frameRate: 6 },
] as const;
