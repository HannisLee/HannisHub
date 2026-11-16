/** 连连看像素素材：全部用代码绘制，不依赖图片文件。
 *
 *  - 图案：36 种 14×14 像素小图标（水果、动物、物件），用字符画定义，每个字符对应调色板中的一种颜色。
 *    左右对称的图案只写左半边 7 列，运行时镜像补全；对称图案里的 h（高光）只保留在左边，镜像一侧换成相邻颜色。
 *  - 方块：象牙色牌面 + 右下方立体侧边，选中、提示、悬停时由引擎叠加描边。
 *  所有素材按原始像素尺寸绘制到离屏画布，渲染时整数倍放大，保持像素风格清晰。 */

export const ICON = 14;
/** 方块占用的格子尺寸（原始像素）：牌面 18×20，右侧 2 像素、下方 4 像素为立体侧边 */
export const CELL_W = 20;
export const CELL_H = 24;
export const FACE_W = 18;
export const FACE_H = 20;

const PALETTE: Record<string, string> = {
  k: "#2a1c18", // 描边
  w: "#ffffff",
  r: "#e5483b",
  R: "#a3282a",
  o: "#f59a2f",
  O: "#c4651d",
  y: "#f8d64a",
  Y: "#c99a1e",
  g: "#5bbd4a",
  G: "#2f7c35",
  l: "#b6e36f",
  b: "#4a93e6",
  B: "#2a54a6",
  c: "#64d2e6",
  p: "#9b63d8",
  P: "#5d3596",
  i: "#f596bd",
  I: "#c75a88",
  n: "#b0703c",
  N: "#6c4022",
  e: "#b9b9b9",
  E: "#6a6a6a",
  s: "#fbd5a6",
  h: "#fff6c4",
  v: "#d4c6f4",
};

interface IconDef {
  name: string;
  rows: string[];
  /** 只写了左半边，镜像补全右半边 */
  sym?: boolean;
}

const ICONS: IconDef[] = [
  // ---- 水果与食物
  { name: "草莓", sym: true, rows: [
    "....g.g", "..kgggg", ".krrggg", "krrrrgg", "krwrrrr", "krrrrrr", "krrrwrr",
    ".krrrrr", ".krwrrr", "..krrrr", "..kRrrw", "...kRrr", "....kRR", ".....kk",
  ] },
  { name: "西瓜", sym: true, rows: [
    ".......", ".......", "kkkkkkk", "kGlrrrr", "kGlrkrr", ".kGlrrr", ".kGlrrk",
    "..kGlrr", "..kGlrr", "...kGlr", "....kGl", ".....kG", "......k", ".......",
  ] },
  { name: "葡萄", sym: true, rows: [
    "......k", ".....kG", "..kkkkk", ".kpppPp", "kphpPpp", "kppPpph", "kpPppPp",
    ".kppPpp", ".kpPpph", "..kppPp", "..kpPpp", "...kppP", "....kpp", ".....kk",
  ] },
  { name: "橙子", sym: true, rows: [
    "......n", "....gGn", "....kkk", "..kkooo", ".kohooo", ".kohooo", "kOooooo",
    "kOooooo", "kOooooo", "kOooooo", ".kOoooo", ".kOOooo", "..kkOOO", "....kkk",
  ] },
  { name: "樱桃", sym: true, rows: [
    "......k", ".....kG", "....kG.", "...kG..", "..kG...", "..kG...", ".kkkk..",
    "krrrrk.", "krhrrk.", "krrrrk.", "kRrrRk.", ".kRRk..", "..kk...", ".......",
  ] },
  { name: "香蕉", rows: [
    "..........kk..", ".........kNk..", "........kyYk..", ".......kyyYk..", "......kyyyYk..",
    ".....kyyyyYk..", "...kkyyyyyYk..", ".kkyyyyyyyYk..", "kyyyyyyyyYk...", "kYyyyyyyYk....",
    ".kYYyyYYk.....", "..kkYYkk......", "....kk........", "..............",
  ] },
  { name: "梨", sym: true, rows: [
    "......n", "......N", ".....kk", "....khl", "....kll", "...klll", "..kllll",
    ".klllll", "klhllll", "kllllll", "kGlllll", ".kGllll", "..kGGll", "....kkk",
  ] },
  { name: "蘑菇", sym: true, rows: [
    ".......", "....kkk", "..kkrrw", ".krrrww", ".krwrrr", "krwwrrr", "krrrrrw",
    ".kkkkkk", "...ksss", "..kssss", "..kssss", "..kesss", "...kkkk", ".......",
  ] },
  { name: "胡萝卜", rows: [
    "........g.g...", "........gGg.g.", ".........gGgg.", "......kkkkGg..", ".....koooOk...",
    "....kooooOk...", "...koooOOk....", "...kooOook....", "..koOoook.....", "..koooOk......",
    ".kooOok.......", ".kOOok........", "kOkk..........", "kk............",
  ] },
  { name: "冰淇淋", sym: true, rows: [
    "......r", "....kkk", "..kkiii", ".kihiii", ".kiiiii", "kiiiiii", "kIiiIii",
    ".kkkkkk", "..knNnN", "..kNnNn", "...knNn", "...kNnN", "....knN", ".....kk",
  ] },
  // ---- 动物
  { name: "小猫", sym: true, rows: [
    "k......", "kk.....", "kok....", "kiok...", "kiookkk", "koooooo", "kookooo",
    "kookooo", "kwooooi", "kOooook", ".kOoooo", "..kkooo", "....kkk", ".......",
  ] },
  { name: "小狗", sym: true, rows: [
    ".......", ".kkkkkk", "kNNssss", "kNNssss", "kNNskss", "kNNskss", "kNNssss",
    ".kNswww", "..kswwk", "..kswww", "...kwww", "....kki", "......i", ".......",
  ] },
  { name: "小猪", sym: true, rows: [
    ".......", ".kk....", ".kik...", ".kiikkk", "kiiiiii", "kiiiiii", "kiikiii",
    "kiiiikk", "kiiikII", "kiiikIk", "kiiiikk", ".kiiiii", "..kkiii", "....kkk",
  ] },
  { name: "青蛙", sym: true, rows: [
    ".......", ".kkk...", "kwwwk..", "kwkkwkk", "kwkkwgg", "kgwwggg", "kgggggg",
    "kgggggg", "kgkgggg", "kggkkkk", ".kggggg", ".kGgggg", "..kkGGG", "....kkk",
  ] },
  { name: "小鸡", sym: true, rows: [
    "......k", "....kkk", "..kkyyy", ".kyyyyy", ".kyykyy", "kyyykyy", "kyyyyoo",
    "kyiyyyo", "kyyyyyy", "kyyyyyy", ".kYyyyy", "..kYYyy", "....kkk", ".......",
  ] },
  { name: "熊猫", sym: true, rows: [
    ".......", ".kk....", "kkkkkkk", "kkwwwww", ".kwwwww", "kwwkkww", "kwkwkww",
    "kwwkkww", "kwwwwwk", "kwwwwww", ".kwwwww", "..kwwww", "...kkkk", ".......",
  ] },
  { name: "兔子", sym: true, rows: [
    "..kk...", ".kwik..", ".kwik..", ".kwik..", ".kwik..", "..kwkkk", ".kwwwww",
    "kwwwwww", "kwwkwww", "kwwwwwi", "kiwwwww", ".kwwwww", "..kkwww", "....kkk",
  ] },
  { name: "小熊", sym: true, rows: [
    ".kkk...", "knnnk..", "knNnkkk", "knnnnnn", "knnnnnn", "knnknnn", "knnknnn",
    "knnnsss", "knnnssk", "knnnsss", ".knnnss", "..kknnn", "....kkk", ".......",
  ] },
  { name: "小鱼", rows: [
    "..............", "..............", ".....kkkkk....", "...kkbbbbbk.kk", "..kbwkbbbbbkbk",
    ".kbbkkbBbbbbbk", "kbbbbbbBbbbbk.", "kbbbbbbBbbbbk.", ".kbbbbbBbbbbbk", "..kbbbbbbbbkbk",
    "...kkbbbbbk.kk", ".....kkkkk....", "..............", "..............",
  ] },
  { name: "企鹅", sym: true, rows: [
    "....kkk", "..kkBBB", ".kBBBBB", ".kBwwww", ".kBwkww", ".kBwwwo", "kBBwwww",
    "kBwwwww", "kBwwwww", "kBwwwww", ".kBwwww", "..kBwww", "..kookk", ".......",
  ] },
  { name: "老鼠", sym: true, rows: [
    ".kkk...", "keiik..", "keiiik.", "keiikkk", ".kkeeee", "..keeee", ".keekee",
    ".keekee", ".keeeee", "..keeei", "..keeee", "...kkee", ".....kk", ".......",
  ] },
  { name: "猫头鹰", sym: true, rows: [
    "k......", "kk.....", "knkkkkk", "knnnnnn", "kwwwnnn", "kwkwnnn", "kwwwnno",
    "knnnnno", "knsssss", "knsNsNs", ".knssss", "..knnnn", "...kkkk", "....y.y",
  ] },
  // ---- 物件
  { name: "星星", sym: true, rows: [
    "......k", ".....ky", ".....ky", "....kyy", "kkkkkyy", "kyyyyyy", ".kyyyyy",
    "..kyyyy", "...kyyy", "...kyyy", "..kyyyk", "..kyykk", ".kykk..", ".kk....",
  ] },
  { name: "爱心", sym: true, rows: [
    ".......", ".......", ".kkkk..", "kiiiik.", "kihiiii", "kiiiiii", "kiiiiii",
    ".kiiiii", "..kiiii", "...kiii", "....kii", ".....ki", "......k", ".......",
  ] },
  { name: "花朵", sym: true, rows: [
    "....kkk", "...kiii", ".kkkiii", "kiiikkk", "kiikyyy", "kiikyhy", "kiikyyy",
    "kiiikkk", ".kkkiii", "...kiii", "....kkg", "..kGGkg", "...kkkg", "......g",
  ] },
  { name: "太阳", sym: true, rows: [
    "......o", ".o.....", "..o.kkk", "...kyyy", "..kyyyy", "..kyyyy", "ookykyy",
    "ookyyyy", "..kyyky", "..kyyyk", "...kyyy", "..o.kkk", ".o.....", "......o",
  ] },
  { name: "月亮", rows: [
    "....kkkkk.....", "..kkhhhk......", ".khhhhk.......", ".khhhk........", "khhhhk........",
    "khhhk.........", "khhhk.........", "khhhk.........", "khhhhk........", ".khhhhk......k",
    ".khhhhhkkkkkYk", "..kkhhhhhhhhk.", "....kkkkkkkk..", "..............",
  ] },
  { name: "云朵", sym: true, rows: [
    ".......", "....kkk", "..kkwww", ".kwwwww", "kwwwwww", "kwwwwww", "kewwwww",
    ".keeeee", "..kkkkk", ".......", "..b..b.", ".b..b..", ".......", ".......",
  ] },
  { name: "雨伞", rows: [
    "......kk......", "....kkppkk....", "..kkppwwppkk..", ".kppppwwppppk.", "kpppppwwpppppk",
    "kpppppwwpppppk", "kPkPkPkkPkPkPk", "......kk......", "......kk......", "......kk......",
    "......kk......", "..kk..kk......", "..kkkkkk......", "...kkkk.......",
  ] },
  { name: "灯笼", sym: true, rows: [
    "......k", "...kYYY", "..kkkkk", ".krrRrr", "krrrRrr", "krhrRrr", "krhrRrr",
    "krrrRrr", ".krrRrr", "..kkkkk", "...kYYY", ".....ky", ".....ky", "......y",
  ] },
  { name: "宝石", sym: true, rows: [
    ".......", ".......", "..kkkkk", ".kccwcc", "kcccwcc", "kkkkkkk", "kccBccc",
    ".kccBcc", "..kccBc", "...kccB", "....kcc", ".....kc", "......k", ".......",
  ] },
  { name: "小树", sym: true, rows: [
    "....kkk", "..kkggg", ".kgglgg", ".kglggg", "kgggggg", "kgGgggg", "kggggGg",
    ".kGgggg", "..kkGGk", "....kkn", ".....kn", ".....kn", "...kkkn", ".......",
  ] },
  { name: "音符", rows: [
    "..............", "..............", "....kkkkkkkk..", "....kbbbbbbk..", "....kbkkkkbk..",
    "....kbk..kbk..", "....kbk..kbk..", "....kbk..kbk..", "..kkkbk.kkbk..", ".kbbbbkkbbbk..",
    "kbbbbbkbbbbk..", "kbbbbkkbbbk...", ".kkkk..kkk....", "..............",
  ] },
  { name: "幽灵", sym: true, rows: [
    "....kkk", "..kkvvv", ".kvvvvv", ".kvkkvv", "kvvkkvv", "kvvvvvv", "kviivvk",
    "kvvvvvv", "kvvvvvv", "kvvvvvv", "kvvkvvk", "kk.kk.k", ".......", ".......",
  ] },
  { name: "糖果", sym: true, rows: [
    ".......", ".......", ".......", "kk.....", "kik.kkk", "kiikrwr", "kiikwrw",
    "kiikrwr", "kik.kkk", "kk.....", ".......", ".......", ".......", ".......",
  ] },
  { name: "皇冠", sym: true, rows: [
    ".......", ".......", "k.....k", "kk...kk", "kyk.kyy", "kyykyyy", "kyyyyyy",
    "kyyryyb", "kyyyyyy", "kYYYYYY", "kkkkkkk", ".......", ".......", ".......",
  ] },
];

export const TILE_KINDS = ICONS.length;

export function iconName(kind: number): string {
  return ICONS[kind - 1]?.name ?? "";
}

/** 展开为 14 行完整字符画（镜像补全对称图案） */
export function iconRows(def: IconDef): string[] {
  if (!def.sym) return def.rows;
  return def.rows.map(half => {
    const right = half.split("").reverse();
    // 镜像一侧的高光换成相邻（靠中线一侧）的颜色
    for (let i = 0; i < right.length; i++) {
      if (right[i] !== "h") continue;
      right[i] = (i > 0 ? right[i - 1] : right[i + 1]) ?? ".";
      if (right[i] === "h") right[i] = right[i + 1] ?? ".";
    }
    return half + right.join("");
  });
}

export function allIconRows(): { name: string; rows: string[] }[] {
  return ICONS.map(def => ({ name: def.name, rows: iconRows(def) }));
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function drawIcon(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number) {
  rows.forEach((line, r) => {
    for (let c = 0; c < line.length; c++) {
      const color = PALETTE[line[c]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x + c, y + r, 1, 1);
    }
  });
}

/** 图案的主要颜色（消除时的碎片颜色）：出现次数最多的三种非描边颜色 */
function mainColors(rows: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of rows) for (const ch of line) if (PALETTE[ch] && ch !== "k") counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ch]) => PALETTE[ch]);
}

export type TileStyle = "normal" | "selected";

/** 方块配色：牌面、高光、暗部、侧边、描边 */
const TILE_COLORS: Record<TileStyle, { face: string; light: string; shade: string; side: string; sideDark: string; line: string }> = {
  normal: { face: "#f6edd6", light: "#fffaee", shade: "#e2d2ad", side: "#c8a873", sideDark: "#9b7c4c", line: "#3b2b20" },
  selected: { face: "#ffe98f", light: "#fff7cc", shade: "#f0c95a", side: "#d98f3c", sideDark: "#a8612a", line: "#3b2b20" },
};

/** 画一个方块（不含图案），原点为牌面左上角 */
function drawTileBase(ctx: CanvasRenderingContext2D, style: TileStyle) {
  const t = TILE_COLORS[style];
  // 立体侧边（右、下）
  ctx.fillStyle = t.line;
  ctx.fillRect(2, 2, FACE_W + 2, FACE_H + 4);
  ctx.fillStyle = t.side;
  ctx.fillRect(3, FACE_H, FACE_W - 1, 3);
  ctx.fillRect(FACE_W, 3, 1, FACE_H);
  ctx.fillStyle = t.sideDark;
  ctx.fillRect(3, FACE_H + 2, FACE_W - 1, 1);
  // 牌面
  ctx.fillStyle = t.line;
  ctx.fillRect(0, 0, FACE_W, FACE_H);
  ctx.fillStyle = t.face;
  ctx.fillRect(1, 1, FACE_W - 2, FACE_H - 2);
  ctx.fillStyle = t.light;
  ctx.fillRect(1, 1, FACE_W - 2, 1);
  ctx.fillRect(1, 1, 1, FACE_H - 2);
  ctx.fillStyle = t.shade;
  ctx.fillRect(2, FACE_H - 2, FACE_W - 3, 1);
  ctx.fillRect(FACE_W - 2, 2, 1, FACE_H - 3);
}

export interface TileAtlas {
  /** kind → 样式 → 预绘制的方块（CELL_W × CELL_H） */
  tile(kind: number, style: TileStyle): HTMLCanvasElement;
  colors(kind: number): string[];
}

export function buildAtlas(): TileAtlas {
  const cache = new Map<string, HTMLCanvasElement>();
  const expanded = ICONS.map(iconRows);
  const palettes = expanded.map(mainColors);
  return {
    tile(kind, style) {
      const key = `${kind}:${style}`;
      let canvas = cache.get(key);
      if (!canvas) {
        canvas = makeCanvas(CELL_W, CELL_H);
        const ctx = canvas.getContext("2d")!;
        drawTileBase(ctx, style);
        const rows = expanded[kind - 1];
        if (rows) drawIcon(ctx, rows, 2, 3);
        cache.set(key, canvas);
      }
      return canvas;
    },
    colors(kind) {
      return palettes[kind - 1] ?? ["#ffffff"];
    },
  };
}

// ---------------------------------------------------------------- 像素数字字体（3×5）

const GLYPHS: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
  "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001010010010",
  "8": "111101111101111", "9": "111101111001111", "+": "000010111010000", "x": "000101010101000",
  ":": "000010000010000", "-": "000000111000000", " ": "000000000000000",
  C: "111100100100111", O: "111101101101111", M: "101111111101101", B: "110101110101110",
  T: "111010010010010", I: "111010010010111", E: "111100111100111",
};

/** 用 3×5 像素字体画一行字，返回宽度；size 为每个字体像素的大小 */
export function drawPixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, outline?: string): number {
  const advance = 4 * size;
  const paint = (ox: number, oy: number, fill: string) => {
    ctx.fillStyle = fill;
    for (let i = 0; i < text.length; i++) {
      const glyph = GLYPHS[text[i]] ?? GLYPHS[" "];
      for (let p = 0; p < 15; p++) {
        if (glyph[p] !== "1") continue;
        ctx.fillRect(x + ox + i * advance + (p % 3) * size, y + oy + Math.floor(p / 3) * size, size, size);
      }
    }
  };
  if (outline) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) paint(dx * size, dy * size, outline);
  }
  paint(0, 0, color);
  return text.length * advance - size;
}
