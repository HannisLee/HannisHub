/** 像素形象：读取角色生成器部件图集（scripts/build_chat_lobby_assets.py 输出的 avatar/*.png + parts.json），
 *  按 身体 → 眼睛 → 服装 → 发型 → 配饰 的顺序叠层，合成与 player.png 相同布局的 96x256 帧表
 *  （6 帧 x 8 行：静止 南/北/左/右 + 行走 南/北/左/右，每帧 16x32）。React 与 Phaser 共用。 */
import type { LobbyAvatar } from "../../../../lib/chat-lobby";
import { ASSET_BASE, assetUrl, type Facing } from "./layout";

export const AVATAR_SLOTS = ["body", "eyes", "outfit", "hair", "accessory"] as const;
export type AvatarSlot = (typeof AVATAR_SLOTS)[number];
/** 每个槽位保存部件编号；可选槽位（发型、配饰）为空字符串表示不戴 */
export type AvatarConfig = LobbyAvatar;

export interface PartItem {
  id: string;
  /** 款式编号（同款不同配色共享） */
  style: string;
  /** 配色编号；身体、眼睛没有配色 */
  variant: string;
}

interface PartCategory {
  file: string;
  optional: boolean;
  items: PartItem[];
}

export interface PartsManifest {
  /** 部件图集内容哈希，用作图片地址的版本号 */
  build?: string;
  frameWidth: number;
  frameHeight: number;
  blockWidth: number;
  blockHeight: number;
  columns: number;
  categories: Record<AvatarSlot, PartCategory>;
}

export interface AvatarParts {
  manifest: PartsManifest;
  images: Record<AvatarSlot, HTMLImageElement>;
  /** 部件编号 → 在图集中的序号 */
  index: Record<AvatarSlot, Map<string, number>>;
}

export const DEFAULT_AVATAR: AvatarConfig = {
  body: "Body_01",
  eyes: "Eyes_01",
  outfit: "Outfit_01_01",
  hair: "Hairstyle_01_01",
  accessory: "",
};

/** 帧表中每个朝向所在的行（静止行；行走行 = 静止行 + 4） */
export const FACING_ROW: Record<Facing, number> = { down: 0, up: 1, left: 2, right: 3 };
export const SHEET_WIDTH = 96;
export const SHEET_HEIGHT = 256;
export const FRAME_WIDTH = 16;
export const FRAME_HEIGHT = 32;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`形象素材加载失败：${src}`));
    image.src = src;
  });
}

let partsPromise: Promise<AvatarParts> | null = null;

/** 加载全部部件图集（约 1.3 MB，浏览器缓存后几乎无开销）；结果在页面内复用，失败后允许重试 */
export function loadAvatarParts(): Promise<AvatarParts> {
  if (!partsPromise) {
    partsPromise = (async () => {
      // 清单每次向服务器确认是否更新，图集按清单中的版本号加载，避免新清单配旧图集
      const response = await fetch(`${ASSET_BASE}/avatar/parts.json`, { cache: "no-cache" });
      if (!response.ok) throw new Error("形象部件清单加载失败");
      const manifest = (await response.json()) as PartsManifest;
      const entries = await Promise.all(AVATAR_SLOTS.map(async slot => {
        const image = await loadImage(assetUrl(manifest.categories[slot].file, manifest.build));
        return [slot, image] as const;
      }));
      const images = Object.fromEntries(entries) as Record<AvatarSlot, HTMLImageElement>;
      const index = Object.fromEntries(AVATAR_SLOTS.map(slot => [
        slot, new Map(manifest.categories[slot].items.map((item, i) => [item.id, i])),
      ])) as Record<AvatarSlot, Map<string, number>>;
      return { manifest, images, index };
    })();
    partsPromise.catch(() => {
      partsPromise = null;
    });
  }
  return partsPromise;
}

/** 部件编号未知（素材更新后被移除等）时退回默认值，可选槽位退回「不戴」 */
export function normalizeAvatar(parts: AvatarParts, config: Partial<AvatarConfig> | null | undefined): AvatarConfig {
  const result = { ...DEFAULT_AVATAR };
  for (const slot of AVATAR_SLOTS) {
    const id = config?.[slot] ?? "";
    if (parts.index[slot].has(id)) result[slot] = id;
    else if (parts.manifest.categories[slot].optional && config) result[slot] = "";
  }
  return result;
}

/** 随机搭配：配饰有一半概率不戴 */
export function randomAvatar(parts: AvatarParts): AvatarConfig {
  const pick = (slot: AvatarSlot) => {
    const items = parts.manifest.categories[slot].items;
    return items[Math.floor(Math.random() * items.length)].id;
  };
  return {
    body: pick("body"),
    eyes: pick("eyes"),
    outfit: pick("outfit"),
    hair: pick("hair"),
    accessory: Math.random() < 0.5 ? "" : pick("accessory"),
  };
}

/** 计算某部件在图集中 96x256 块的左上角 */
function blockOrigin(parts: AvatarParts, slot: AvatarSlot, id: string): [number, number] | null {
  const i = parts.index[slot].get(id);
  if (i === undefined) return null;
  const { columns, blockWidth, blockHeight } = parts.manifest;
  return [(i % columns) * blockWidth, Math.floor(i / columns) * blockHeight];
}

/** 把形象的某一帧（帧表内坐标 sx, sy, 尺寸 sw x sh）按 scale 倍画到目标画布 (dx, dy) */
export function drawAvatarRegion(
  ctx: CanvasRenderingContext2D,
  parts: AvatarParts,
  config: Partial<AvatarConfig>,
  region: { sx: number; sy: number; sw: number; sh: number },
  dx: number,
  dy: number,
  scale = 1,
) {
  ctx.imageSmoothingEnabled = false;
  for (const slot of AVATAR_SLOTS) {
    const id = config[slot];
    if (!id) continue;
    const origin = blockOrigin(parts, slot, id);
    if (!origin) continue;
    ctx.drawImage(
      parts.images[slot],
      origin[0] + region.sx, origin[1] + region.sy, region.sw, region.sh,
      dx, dy, region.sw * scale, region.sh * scale,
    );
  }
}

/** 合成完整帧表（供 Phaser 作为角色贴图） */
export function composeAvatarSheet(parts: AvatarParts, config: AvatarConfig): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SHEET_WIDTH;
  canvas.height = SHEET_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (ctx) drawAvatarRegion(ctx, parts, config, { sx: 0, sy: 0, sw: SHEET_WIDTH, sh: SHEET_HEIGHT }, 0, 0);
  return canvas;
}

/** 画单帧：facing 朝向，walking 是否行走，frame 为 0–5 帧序 */
export function drawAvatarFrame(
  ctx: CanvasRenderingContext2D,
  parts: AvatarParts,
  config: Partial<AvatarConfig>,
  facing: Facing,
  walking: boolean,
  frame: number,
  dx: number,
  dy: number,
  scale: number,
) {
  const row = FACING_ROW[facing] + (walking ? 4 : 0);
  drawAvatarRegion(
    ctx, parts, config,
    { sx: (frame % 6) * FRAME_WIDTH, sy: row * FRAME_HEIGHT, sw: FRAME_WIDTH, sh: FRAME_HEIGHT },
    dx, dy, scale,
  );
}
