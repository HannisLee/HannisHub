import Phaser from "phaser";
import {
  buildTileGrid, FURNITURE, OBJECT_KEYS, SPAWN, TILE, WALL_TILES, WORLD_H, WORLD_W,
} from "./office-map";
import { Player, type TouchState } from "./player";

export interface LobbySceneOptions {
  touch: TouchState;
  onProgress?: (value: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

const ASSET_BASE = "/chat-lobby";

/** 聊天大厅主场景：加载素材、铺设办公室、放置家具与碰撞、驱动角色与相机。 */
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

    this.load.image("office-tiles", `${ASSET_BASE}/office/tiles_sheet.png`);
    this.load.spritesheet("player", `${ASSET_BASE}/npc/player.png`, { frameWidth: 12, frameHeight: 16 });
    for (const key of OBJECT_KEYS) {
      this.load.image(key, `${ASSET_BASE}/office/objects/${key}.png`);
    }
  }

  create() {
    if (this.failed) return;

    // 地板与墙砖
    const map = this.make.tilemap({ data: buildTileGrid(), tileWidth: TILE, tileHeight: TILE });
    const tileset = map.addTilesetImage("office-tiles", "office-tiles", TILE, TILE, 0, 0, 0);
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

    this.player = new Player(this, SPAWN.x, SPAWN.y, this.opts.touch);
    this.physics.add.collider(this.player, layer);
    this.physics.add.collider(this.player, solids);

    this.cameras.main.setBackgroundColor("#141413");
    this.applyCameraSize();
    this.scale.on("resize", this.applyCameraSize, this);

    this.opts.onReady?.();
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