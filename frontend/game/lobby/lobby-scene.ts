import Phaser from "phaser";
import {
  ANIMATED_OBJECTS, buildTileGrid, FURNITURE, OBJECT_KEYS, SPAWN, TILE, WALL_TILES, WORLD_H, WORLD_W,
} from "./room-map";
import { Player, type TouchState } from "./player";

export interface LobbySceneOptions {
  touch: TouchState;
  onProgress?: (value: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

const ASSET_BASE = "/chat-lobby/modern";

/** 聊天大厅主场景：加载付费素材、铺设客厅、放置家具与碰撞、驱动角色/动画物件与相机。 */
export class LobbyScene extends Phaser.Scene {
  private opts: LobbySceneOptions;
  private player!: Player;
  private failed = false;

  constructor(opts: LobbySceneOptions) {
    super("lobby");
    this.opts = opts;
  }

  preload() {
    this.load.on("progress", (value: number) => this.opts.onProgress?.(value));
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      this.failed = true;
      this.opts.onError?.(`素材加载失败：${file.key}`);
    });

    this.load.image("room-tiles", `${ASSET_BASE}/tiles_sheet.png`);
    this.load.spritesheet("player", `${ASSET_BASE}/player.png`, { frameWidth: 16, frameHeight: 32 });
    for (const key of OBJECT_KEYS) {
      this.load.image(key, `${ASSET_BASE}/objects/${key}.png`);
    }
    for (const obj of ANIMATED_OBJECTS) {
      this.load.spritesheet(obj.key, `${ASSET_BASE}/objects/${obj.key}.png`, {
        frameWidth: obj.frameWidth,
        frameHeight: obj.frameHeight,
      });
    }
    this.load.spritesheet("door", `${ASSET_BASE}/objects/door.png`, { frameWidth: 16, frameHeight: 32 });
  }

  create() {
    if (this.failed) return;

    // 地板与墙砖
    const map = this.make.tilemap({ data: buildTileGrid(), tileWidth: TILE, tileHeight: TILE });
    const tileset = map.addTilesetImage("room-tiles", "room-tiles", TILE, TILE, 0, 0, 0);
    const layer = map.createLayer(0, tileset!, 0, 0);
    if (!layer) return;
    layer.setDepth(0);
    layer.setCollision(WALL_TILES);

    // 家具：视觉 sprite 按底边深度排序，碰撞用独立静态 zone
    const solids: Phaser.GameObjects.Zone[] = [];
    for (const def of FURNITURE) {
      const bottom = def.y + def.h;
      const sprite = this.add.image(def.x + def.w / 2, bottom, def.key).setOrigin(0.5, 1);
      sprite.setDepth(def.depth ?? bottom);
      if (def.solid) {
        const { w, h, ox, oy } = def.solid;
        const zone = this.add.zone(def.x + ox + w / 2, def.y + oy + h / 2, w, h);
        this.physics.add.existing(zone, true);
        solids.push(zone);
      }
    }

    // 门与挂钟贴墙（低深度），电视落在柜面上、猫睡在中央区域毯上，参与前后遮挡
    this.add.image(16 * TILE + 8, 2 * TILE, "door", 0).setOrigin(0.5, 1).setDepth(2);
    this.addAnimated("clock", 12 * TILE + 8, 2 * TILE, 2);
    this.addAnimated("tv", 24 * TILE + 16, 18 * TILE + 20, 18 * TILE + 32 + 1);
    this.addAnimated("cat", 14 * TILE + 16, 10 * TILE + 22, 10 * TILE + 22);

    this.player = new Player(this, SPAWN.x, SPAWN.y, this.opts.touch);
    this.physics.add.collider(this.player, layer);
    this.physics.add.collider(this.player, solids);

    this.cameras.main.setBackgroundColor("#141413");
    this.applyCameraSize();
    this.scale.on("resize", this.applyCameraSize, this);

    this.opts.onReady?.();
  }

  /** 创建循环动画物件：帧数由贴图尺寸推导，避免与素材帧数硬耦合。 */
  private addAnimated(key: string, x: number, y: number, depth: number) {
    const def = ANIMATED_OBJECTS.find(o => o.key === key)!;
    const texture = this.textures.get(key);
    const frameCount = Math.floor(texture.getSourceImage().width / def.frameWidth);
    const animKey = `anim-${key}`;
    if (!this.anims.exists(animKey)) {
      this.anims.create({
        key: animKey,
        frames: Array.from({ length: frameCount }, (_, i) => ({ key, frame: i })),
        frameRate: def.frameRate,
        repeat: -1,
      });
    }
    this.add.sprite(x, y, key).setOrigin(0.5, 1).setDepth(depth).play(animKey);
  }

  /** 整数倍缩放保持像素清晰：优先按宽度适配让整个房间横向完整可见（大屏 3×、常规 2×），
   *  视野装得下整个房间时居中静止，否则跟随角色。 */
  private applyCameraSize() {
    const cam = this.cameras.main;
    const { width, height } = this.scale;
    const zoom = Math.max(2, Math.min(3, Math.floor(width / WORLD_W)));
    cam.setZoom(zoom);
    const viewW = width / zoom;
    const viewH = height / zoom;
    if (viewW >= WORLD_W && viewH >= WORLD_H) {
      cam.stopFollow();
      cam.setBounds(0, 0, Math.max(WORLD_W, viewW), Math.max(WORLD_H, viewH));
      cam.centerOn(WORLD_W / 2, WORLD_H / 2);
    } else {
      cam.setBounds(0, 0, WORLD_W, WORLD_H);
      cam.startFollow(this.player, true, 0.12, 0.12);
    }
  }

  update() {
    if (this.failed) return;
    this.player.update();
  }
}