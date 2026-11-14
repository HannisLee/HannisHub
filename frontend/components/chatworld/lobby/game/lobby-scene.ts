import Phaser from "phaser";
import {
  ASSET_BASE, assetUrl, type ActionDef, type DeskDef, type DoorDef, type InteractKind, type LobbyBridge,
  type LobbyEvents, type LobbyLayout, type MachineDef, type NearbyInfo, type PortalDef, type Rect, type RoomDef, type SeatDef,
} from "./layout";
import {
  LOBBY_EMOTES, LOBBY_NOTES_EVENT, QUICK_EMOTES, type LobbyAvatar, type LobbyRemotePlayer, type LobbyServerMessage,
} from "../../../../lib/chat-lobby";
import { playTune } from "./tunes";
import {
  AVATAR_SLOTS, composeAvatarSheet, FRAME_HEIGHT, FRAME_WIDTH, loadAvatarParts, normalizeAvatar, SHEET_HEIGHT, SHEET_WIDTH,
} from "./avatar";
import { NavGrid, type Point } from "./pathfinding";
import { Player } from "./player";
import { PresenceClient } from "./presence-client";
import { RemotePlayer } from "./remote-player";

/** 房间里可按 E 交互的对象（机器、工位、座位、小互动），rect 为世界坐标下的站立区 */
interface Interactable {
  kind: InteractKind;
  id: string;
  rect: Phaser.Geom.Rectangle;
  machine?: MachineDef;
  desk?: DeskDef;
  seat?: SeatDef;
  action?: ActionDef;
}

/** 头顶气泡：跟随角色，到时自动消失 */
interface Bubble {
  container: Phaser.GameObjects.Container;
  follow: () => { x: number; y: number; visible: boolean };
  until: number;
}

/** 世界坐标下的房间：在布局数据基础上附加偏移后的矩形，便于判定 */
interface RuntimeRoom {
  def: RoomDef;
  portals: { def: PortalDef; rect: Phaser.Geom.Rectangle }[];
  interactables: Interactable[];
  /** 可演奏的钢琴精灵（坐上琴凳时播放按键动画） */
  pianos: Phaser.GameObjects.Sprite[];
  /** holdUntil：到达时开合一次的门在此时刻之前保持打开，不受距离判定影响 */
  doors: { def: DoorDef; sprite: Phaser.GameObjects.Sprite; cx: number; cy: number; open: boolean; holdUntil: number }[];
  onceAnims: Phaser.GameObjects.Sprite[];
}

const FADE_MS = 220;
/** 自定义形象贴图键：一张常驻的画布贴图，形象变化时重绘并刷新，已有动画与精灵无需重建 */
const AVATAR_TEXTURE = "avatar-self";
/** 我的房间：私有，不同步位置；其他人下线后自动走回这里 */
const PRIVATE_ROOM = "room";
/** 其他人在该距离内出现在带 cycleDoor 的出生点时，视为刚从电梯出来，电梯开合一次 */
const ARRIVE_DISTANCE = 6;
const CAMERA_MARGIN = 12;
/** 自己发表情的最短间隔，避免连按刷屏（服务端另有限速） */
const EMOTE_COOLDOWN_MS = 700;
const BUBBLE_MS = 2400;
/** 说话气泡（回车输入的一句话）停留更久，按字数延长 */
const SAY_MS = 4500;
const SAY_MS_PER_CHAR = 90;
/** 说话气泡的最大宽度（世界像素），超出自动换行 */
const SAY_WRAP = 96;
const SELF_ID = "self";
/** 自己头顶气泡的高度（本地角色不显示名字，气泡直接在头顶）；头顶有「E」按键提示时再往上抬，避免互相遮挡 */
const SELF_BUBBLE_Y = 33;
const SELF_BUBBLE_Y_WITH_PROMPT = 49;
/** 与猫互动的随机反应（表情键，广播后其他人也看到同样的反应） */
const CAT_REACTIONS = ["catpurr", "catflip", "catzzz", "catrun", "catmeow"] as const;
type CatReaction = (typeof CAT_REACTIONS)[number];
const LABEL_FONT = '"Anthropic Sans", Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
/** 文字纹理放大倍数：世界坐标 1px 在屏幕上会被放大 2–4 倍，文字需更高分辨率才清晰 */
const TEXT_RESOLUTION = 6;

const COLORS = {
  surface: 0x1f1e1d,
  border: 0x454440,
  text: "#FAF9F5",
  muted: "#B0AEA5",
  brand: 0xd97757,
};

/** 焦点在可输入元素上时（输入框、文本域、可编辑区域）不应拦截按键 */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** 聊天大厅主场景：读取 layout.json 搭建入口厅与大厅，处理碰撞、门、房间切换与机器交互。 */
export class LobbyScene extends Phaser.Scene {
  private bridge: LobbyBridge;
  private events_: LobbyEvents;
  private layout!: LobbyLayout;
  private player!: Player;
  private rooms = new Map<string, RuntimeRoom>();
  private current!: RuntimeRoom;
  private nearby: NearbyInfo | null = null;
  /** 当前坐着的工位（坐在工位上再按 E 重新打开待办） */
  private seatedDesk: string | null = null;
  private deskVersion = -1;
  private deskTags = new Map<string, Phaser.GameObjects.Container>();
  private bubbles = new Map<string, Bubble>();
  private lastEmoteAt = 0;
  private lastSayAt = 0;
  private lastCatReaction: CatReaction | null = null;
  /** 正在跑开、还没回来的猫 */
  private busyCats = new Set<Phaser.GameObjects.Sprite>();
  /** 交互键按下标记：在 keydown 事件里置位，避免按下与抬起落在同一帧时 JustDown 丢失快速轻按 */
  private interactPressed = false;
  private prompt!: Phaser.GameObjects.Container;
  private transitioning = false;
  private paused = false;
  private failed = false;
  private avatarVersion = -1;
  private presence: PresenceClient | null = null;
  /** 其他人的角色，键为服务端角色编号 */
  private remotes = new Map<string, RemotePlayer>();
  /** 每个房间的寻路网格，首次需要时生成 */
  private navGrids = new Map<string, NavGrid>();
  /** 其他人的形象贴图：形象去重键 → 贴图键（已合成）；pending 为正在合成的键 */
  private remoteSkins = new Map<string, string>();
  private remoteSkinPending = new Set<string>();
  private destroyed = false;

  constructor(bridge: LobbyBridge, events: LobbyEvents) {
    super("lobby");
    this.bridge = bridge;
    this.events_ = events;
  }

  preload() {
    this.load.on("progress", (value: number) => this.events_.onProgress?.(value));
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      this.failed = true;
      this.events_.onError?.(`素材加载失败：${file.key}`);
    });

    // 先读布局（时间戳参数绕过缓存，保证拿到最新版本号），再按布局带版本号追加其余素材：
    // 图集图片与坐标表必须来自同一次构建，否则家具会显示成错误的贴图
    this.load.json("layout", `${ASSET_BASE}/layout.json?t=${Date.now()}`);
    this.load.once("filecomplete-json-layout", (_key: string, _type: string, data: LobbyLayout) => {
      const url = (file: string) => assetUrl(file, data.build);
      for (const room of data.rooms) this.load.image(`bg-${room.id}`, url(room.background));
      for (const [key, sheet] of Object.entries(data.anims)) {
        this.load.spritesheet(key, url(sheet.file), {
          frameWidth: sheet.frameWidth,
          frameHeight: sheet.frameHeight,
        });
      }
      this.load.atlas("objects", url("objects.png"), url("objects.json"));
      this.load.spritesheet("player", url("player.png"), { frameWidth: 16, frameHeight: 32 });
    });
  }

  create() {
    if (this.failed) return;
    this.layout = this.cache.json.get("layout") as LobbyLayout;
    const { width, height } = this.layout.world;
    this.physics.world.setBounds(0, 0, width, height);

    this.createAnimations();
    const solids = this.physics.add.staticGroup();
    for (const room of this.layout.rooms) this.rooms.set(room.id, this.buildRoom(room, solids));

    // 页面可指定出生点（普通账号从我的房间开始），无效时退回布局默认入口
    const custom = this.bridge.start;
    const startRef = custom && this.rooms.get(custom.room)?.def.spawns[custom.spawn] ? custom : this.layout.start;
    const start = this.rooms.get(startRef.room)!;
    const spawn = start.def.spawns[startRef.spawn];
    this.createSheetTexture(AVATAR_TEXTURE);
    this.player = new Player(this, start.def.x + spawn.x, start.def.y + spawn.y, this.bridge, this.applyAvatar());
    this.physics.add.collider(this.player, solids);

    const keyboard = this.input.keyboard!;
    // addKey 同时负责拦截按键默认行为（如空格滚动页面）
    keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    const markInteract = (event: KeyboardEvent) => {
      if (!event.repeat) this.interactPressed = true;
    };
    keyboard.on("keydown-E", markInteract);
    keyboard.on("keydown-SPACE", markInteract);
    // 数字键 1–4：快捷表情（面板打开或输入框聚焦时键盘已停用）
    (["ONE", "TWO", "THREE", "FOUR"] as const).forEach((name, i) => {
      keyboard.addKey(Phaser.Input.Keyboard.KeyCodes[name]);
      keyboard.on(`keydown-${name}`, (event: KeyboardEvent) => {
        if (!event.repeat) this.emote(QUICK_EMOTES[i]);
      });
    });
    this.player.onStand = () => {
      this.seatedDesk = null;
    };
    this.prompt = this.createPrompt();

    this.cameras.main.setBackgroundColor("#141413");
    this.enterRoom(start);
    this.scale.on("resize", this.applyCamera, this);

    // 初次进入：一次性动画播放一遍，出生点要求时电梯开合一次，营造「刚到达」的感觉
    this.time.delayedCall(250, () => start.onceAnims.forEach(sprite => sprite.play(`anim-${sprite.texture.key}`)));
    if (spawn.cycleDoor) this.time.delayedCall(250, () => this.cycleDoors(start));
    this.cameras.main.fadeIn(400, 20, 20, 19);

    // 多人同步：游戏销毁（离开页面）时断开连接，其他人随后看到该角色走回私有房间
    this.presence = new PresenceClient(message => this.handlePresence(message));
    this.events.once(Phaser.Scenes.Events.DESTROY, () => {
      this.destroyed = true;
      this.presence?.destroy();
      this.presence = null;
    });
    this.events_.onReady?.();
  }

  /** 为每个动画帧条创建动画；自动门（玻璃门）额外按布局给出的帧序拆出开门 / 关门两段 */
  private createAnimations() {
    // 只在特定时机播放一次的帧条（如电梯开合）不循环
    const playOnce = new Set(this.layout.rooms.flatMap(room => room.anims.filter(a => a.frames === "once").map(a => a.key)));
    for (const [key, sheet] of Object.entries(this.layout.anims)) {
      const animKey = `anim-${key}`;
      if (this.anims.exists(animKey)) continue;
      this.anims.create({
        key: animKey,
        frames: this.anims.generateFrameNumbers(key),
        frameRate: sheet.frameRate,
        repeat: sheet.door || playOnce.has(key) ? 0 : -1,
      });
      if (sheet.door) {
        this.anims.create({ key: `${key}-open`, frames: this.anims.generateFrameNumbers(key, { frames: sheet.door.open }), frameRate: sheet.frameRate });
        this.anims.create({ key: `${key}-close`, frames: this.anims.generateFrameNumbers(key, { frames: sheet.door.close }), frameRate: sheet.frameRate });
      }
    }
  }

  /** 创建 96x320 的画布贴图并切出 60 帧（与 player.png 相同布局） */
  private createSheetTexture(key: string): Phaser.Textures.CanvasTexture | null {
    if (this.textures.exists(key)) this.textures.remove(key);
    const texture = this.textures.createCanvas(key, SHEET_WIDTH, SHEET_HEIGHT);
    if (!texture) return null;
    const columns = SHEET_WIDTH / FRAME_WIDTH;
    const count = columns * (SHEET_HEIGHT / FRAME_HEIGHT);
    for (let i = 0; i < count; i++) {
      texture.add(i, 0, (i % columns) * FRAME_WIDTH, Math.floor(i / columns) * FRAME_HEIGHT, FRAME_WIDTH, FRAME_HEIGHT);
    }
    texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    return texture;
  }

  /** 把桥接对象中的形象帧表画进画布贴图；返回应使用的皮肤（无自定义形象时为默认角色） */
  private applyAvatar(): string {
    this.avatarVersion = this.bridge.avatar.version;
    const sheet = this.bridge.avatar.sheet;
    const texture = this.textures.get(AVATAR_TEXTURE) as Phaser.Textures.CanvasTexture;
    if (!sheet || !texture?.context) return "player";
    texture.context.clearRect(0, 0, SHEET_WIDTH, SHEET_HEIGHT);
    texture.context.drawImage(sheet, 0, 0);
    texture.refresh();
    return AVATAR_TEXTURE;
  }

  private buildRoom(def: RoomDef, solids: Phaser.Physics.Arcade.StaticGroup): RuntimeRoom {
    const ox = def.x;
    const oy = def.y;
    const addSolid = ([x, y, w, h]: Rect) => {
      const zone = this.add.zone(ox + x + w / 2, oy + y + h / 2, w, h);
      solids.add(zone);
    };

    this.add.image(ox, oy, `bg-${def.id}`).setOrigin(0).setDepth(-10000);
    def.walls.forEach(addSolid);

    for (const prop of def.props) {
      const image = this.add.image(ox + prop.x, oy + prop.y, "objects", prop.key).setOrigin(0);
      image.setDepth(oy + (prop.depth ?? prop.y + image.height));
      if (prop.solid) addSolid(prop.solid);
    }

    const onceAnims: Phaser.GameObjects.Sprite[] = [];
    const pianos: Phaser.GameObjects.Sprite[] = [];
    for (const anim of def.anims) {
      const sprite = this.add.sprite(ox + anim.x, oy + anim.y, anim.key, 0).setOrigin(0);
      sprite.setDepth(oy + (anim.depth ?? anim.y + sprite.height));
      // 钢琴只在有人弹奏时播放，不参与「到达时播放一次」
      if (anim.key === "piano") pianos.push(sprite);
      else if (anim.frames === "once") onceAnims.push(sprite);
      else {
        // 随机起始帧，避免同款物件（显示器、音箱）同步闪动
        const count = this.anims.get(`anim-${anim.key}`).frames.length;
        sprite.play({ key: `anim-${anim.key}`, startFrame: Phaser.Math.Between(0, count - 1) });
      }
      if (anim.solid) addSolid(anim.solid);
    }

    const doors = def.doors.map(door => {
      const sprite = this.add.sprite(ox + door.x, oy + door.y, door.key, 0).setOrigin(0);
      sprite.setDepth(oy + (door.depth ?? door.y + sprite.height));
      return { def: door, sprite, cx: ox + door.x + sprite.width / 2, cy: oy + door.y + sprite.height, open: false, holdUntil: 0 };
    });

    for (const sign of def.signs) this.createSign(ox + sign.x, oy + sign.y, sign.text, sign.tone === "brand");
    for (const machine of def.machines) this.createMachineSign(ox + machine.signX, oy + machine.signY, machine);

    const toRect = ([x, y, w, h]: Rect) => new Phaser.Geom.Rectangle(ox + x, oy + y, w, h);
    const interactables: Interactable[] = [
      ...def.machines.map(machine => ({ kind: "machine" as const, id: machine.id, rect: toRect(machine.zone), machine })),
      ...(def.desks ?? []).map(desk => ({ kind: "desk" as const, id: desk.id, rect: toRect(desk.zone), desk })),
      ...(def.seats ?? []).map(seat => ({ kind: "seat" as const, id: seat.id, rect: toRect(seat.zone), seat })),
      ...(def.actions ?? []).map(action => ({ kind: "action" as const, id: action.id, rect: toRect(action.zone), action })),
    ];
    return {
      def,
      portals: def.portals.map(portal => ({ def: portal, rect: toRect(portal.rect) })),
      interactables,
      pianos,
      doors,
      onceAnims,
    };
  }

  private makeText(text: string, size: number, color: string, weight = 500, wrap = 0) {
    const label = this.add.text(0, 0, text, {
      fontFamily: LABEL_FONT,
      fontSize: `${size}px`,
      fontStyle: String(weight),
      color,
      resolution: TEXT_RESOLUTION,
      align: "center",
      // 中文没有空格，需要按字符换行
      ...(wrap ? { wordWrap: { width: wrap, useAdvancedWrap: true } } : {}),
    });
    label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    return label.setOrigin(0.5, 0.5);
  }

  /** 墙上的小型标牌（如入口厅品牌、出口方向、工位名牌） */
  private createSign(x: number, y: number, text: string, brand: boolean) {
    const label = this.makeText(text, brand ? 6 : 5.5, brand ? COLORS.text : COLORS.muted);
    const w = Math.ceil(label.width) + 10;
    const h = 10;
    const g = this.add.graphics();
    g.fillStyle(COLORS.surface, 0.92).fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(0.5, brand ? COLORS.brand : COLORS.border, 1).strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    return this.add.container(x, y, [g, label]).setDepth(50000);
  }

  /** 其他人头顶的名字标签：半透明深色胶囊 + 浅色文字，始终显示在家具与标牌之上 */
  private makeNameTag = (name: string) => {
    const label = this.makeText(name, 5.5, COLORS.text);
    const w = Math.ceil(label.width) + 8;
    const h = 9;
    const g = this.add.graphics();
    g.fillStyle(COLORS.surface, 0.82).fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(0.5, COLORS.border, 1).strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    // 高于墙面标牌（50000），低于按键提示（60000）
    return this.add.container(0, 0, [g, label]).setDepth(55000);
  };

  /** 机器上方的悬浮铭牌：品牌色指示点 + 名称，轻微上下浮动 */
  private createMachineSign(x: number, y: number, machine: MachineDef) {
    const label = this.makeText(machine.title, 6.5, COLORS.text);
    const w = Math.ceil(label.width) + 18;
    const h = 12;
    const g = this.add.graphics();
    g.fillStyle(COLORS.surface, 0.94).fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(0.5, COLORS.border, 1).strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.fillStyle(COLORS.brand, 1).fillCircle(-w / 2 + 7, 0, 1.6);
    label.setX(4);
    const sign = this.add.container(x, y, [g, label]).setDepth(50000);
    this.tweens.add({ targets: sign, y: y - 1.5, duration: 1400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  }

  /** 靠近机器时在角色头顶显示的「E」按键提示 */
  private createPrompt() {
    const size = 10;
    const g = this.add.graphics();
    g.fillStyle(0xfaf9f5, 1).fillRoundedRect(-size / 2, -size / 2, size, size, 2.5);
    g.fillStyle(0x8f8e89, 1).fillRect(-size / 2 + 1.5, size / 2 - 0.5, size - 3, 1);
    const label = this.makeText("E", 7, "#1C1B19", 600);
    const container = this.add.container(0, 0, [g, label]).setDepth(60000).setVisible(false);
    this.tweens.add({ targets: label, scale: 0.9, duration: 600, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    return container;
  }

  private enterRoom(room: RuntimeRoom) {
    this.current = room;
    this.applyCamera();
    this.events_.onRoomChange?.({ id: room.def.id, name: room.def.name });
    this.setNearby(null);
  }

  /** 整数倍缩放保持像素清晰：房间能完整放下时居中静止，否则跟随角色；相机限定在当前房间内 */
  private applyCamera() {
    if (!this.current || !this.player) return;
    const cam = this.cameras.main;
    const room = this.current.def;
    const { width, height } = this.scale;
    const fit = Math.floor(Math.min(width / room.width, height / room.height));
    const zoom = Phaser.Math.Clamp(fit, 2, 4);
    cam.setZoom(zoom);
    const viewW = width / zoom;
    const viewH = height / zoom;
    // 房间四周留出少量暗色边距，避免贴顶的铭牌被舞台边缘裁切。房间本身恰好放得下、
    // 只是加上边距才超出时，把边距收窄到剩余空间，让整个房间静止完整显示，而不是为几像素边距滚动、裁掉顶部铭牌
    const marginX = room.width <= viewW ? Math.min(CAMERA_MARGIN, (viewW - room.width) / 2) : CAMERA_MARGIN;
    const marginY = room.height <= viewH ? Math.min(CAMERA_MARGIN, (viewH - room.height) / 2) : CAMERA_MARGIN;
    const roomW = room.width + marginX * 2;
    const roomH = room.height + marginY * 2;
    const padX = Math.max(0, (viewW - roomW) / 2);
    const padY = Math.max(0, (viewH - roomH) / 2);
    cam.setBounds(
      room.x - marginX - padX, room.y - marginY - padY,
      Math.max(roomW, viewW), Math.max(roomH, viewH),
    );
    cam.startFollow(this.player, true, 0.14, 0.14, 0, 8);
    cam.centerOn(this.player.x, this.player.y);
  }

  private travel(portal: PortalDef) {
    const target = this.rooms.get(portal.to);
    if (!target || this.transitioning) return;
    this.transitioning = true;
    this.player.frozen = true;
    const cam = this.cameras.main;
    cam.fadeOut(FADE_MS, 20, 20, 19);
    cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      const spawn = target.def.spawns[portal.spawn];
      this.player.teleport(target.def.x + spawn.x, target.def.y + spawn.y, spawn.dir);
      this.enterRoom(target);
      if (spawn.cycleDoor) this.cycleDoors(target);
      cam.fadeIn(FADE_MS + 60, 20, 20, 19);
      this.time.delayedCall(FADE_MS, () => {
        this.transitioning = false;
        this.player.frozen = this.paused;
      });
    });
  }

  /** 让房间里的自动门立刻打开并保持一小会儿，随后由 update 的距离判定自然关上 */
  private cycleDoors(room: RuntimeRoom) {
    const holdUntil = this.time.now + 1100;
    for (const door of room.doors) {
      door.holdUntil = holdUntil;
      if (!door.open) {
        door.open = true;
        door.sprite.play(`${door.def.key}-open`);
      }
    }
  }

  private setNearby(info: NearbyInfo | null) {
    const same = this.nearby && info && this.nearby.id === info.id && this.nearby.kind === info.kind
      && this.nearby.title === info.title && this.nearby.hint === info.hint;
    if (same || (!this.nearby && !info)) return;
    this.nearby = info;
    this.prompt.setVisible(Boolean(info));
    this.events_.onNearby?.(info);
  }

  /** 工位的标题与提示随归属变化：自己的、别人的、空闲 */
  private deskInfo(desk: DeskDef): NearbyInfo {
    const claim = this.bridge.desks.claims[desk.id];
    if (claim?.mine) return { kind: "desk", id: desk.id, title: "我的工位", hint: "坐下并打开待办" };
    if (claim) return { kind: "desk", id: desk.id, title: `${claim.name} 的工位`, hint: "借坐一会儿" };
    return { kind: "desk", id: desk.id, title: "空闲工位", hint: "坐下，可以认领为自己的工位" };
  }

  private describe(item: Interactable): NearbyInfo {
    if (item.machine) return { kind: "machine", id: item.id, title: item.machine.title, hint: item.machine.hint };
    if (item.desk) return this.deskInfo(item.desk);
    if (item.seat) {
      return { kind: "seat", id: item.id, title: item.seat.title, hint: item.seat.play === "piano" ? "坐下弹一段" : "按方向键起身" };
    }
    return { kind: "action", id: item.id, title: item.action!.title, hint: item.action!.hint };
  }

  /** 脚底所在的交互区；重叠时取面积最小（更具体）的一个 */
  private findInteractable(x: number, y: number): Interactable | null {
    let best: Interactable | null = null;
    for (const item of this.current.interactables) {
      if (!item.rect.contains(x, y)) continue;
      if (!best || item.rect.width * item.rect.height < best.rect.width * best.rect.height) best = item;
    }
    return best;
  }

  private interact(item: Interactable) {
    const room = this.current.def;
    if (item.machine) {
      this.events_.onInteract?.({ id: item.machine.id, title: item.machine.title, hint: item.machine.hint });
    } else if (item.desk) {
      const seat = item.desk.seat;
      this.player.sit(room.x + seat.x, room.y + seat.y, seat.dir);
      this.seatedDesk = item.desk.id;
      this.events_.onDesk?.(item.desk.id);
    } else if (item.seat) {
      const seat = item.seat;
      this.player.sit(room.x + seat.x, room.y + seat.y, seat.dir);
      if (seat.play === "piano") this.playPiano(room.x + seat.x, room.y + seat.y);
    } else if (item.action) {
      if (item.action.id === "cat") this.petCat(item.rect);
      else this.emote(item.action.id);
      if (item.action.sound) playTune(item.action.sound);
    }
  }

  /** 坐上琴凳：最近的一架钢琴播放按键动画，并弹一段随机旋律 */
  private playPiano(x: number, y: number) {
    let piano: Phaser.GameObjects.Sprite | null = null;
    let best = Infinity;
    for (const sprite of this.current.pianos) {
      const d = Phaser.Math.Distance.Between(x, y, sprite.x + sprite.width / 2, sprite.y + sprite.height);
      if (d < best) {
        best = d;
        piano = sprite;
      }
    }
    piano?.play({ key: "anim-piano", repeat: 3 });
    playTune("piano");
    this.emote("piano");
  }

  // ---------- 表情气泡 ----------

  /** 自己发表情：头顶冒泡并广播给同房间的人 */
  private emote(key: string) {
    const texts = LOBBY_EMOTES[key];
    if (!texts || this.paused || this.transitioning) return;
    const now = this.time.now;
    if (now - this.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
    this.lastEmoteAt = now;
    const text = texts[Math.floor(Math.random() * texts.length)];
    this.showBubble(SELF_ID, text, this.selfBubbleAnchor);
    // 私有房间里的表情不广播
    if (this.current.def.id !== PRIVATE_ROOM) this.presence?.sendEmote(key);
  }

  /** 自己头顶气泡的位置：有「E」提示时抬高，两者不重叠 */
  private selfBubbleAnchor = () => ({
    x: this.player.x,
    y: this.player.y - (this.prompt.visible ? SELF_BUBBLE_Y_WITH_PROMPT : SELF_BUBBLE_Y),
    visible: true,
  });

  private remoteBubbleAnchor(remote: RemotePlayer) {
    return () => ({ x: remote.sprite.x, y: remote.sprite.y - RemotePlayer.BUBBLE_OFFSET_Y, visible: remote.shown });
  }

  /** 回车输入的一句话：头顶显示并广播给同房间的人（私有房间只自己看到） */
  private say(text: string) {
    const now = this.time.now;
    if (!text || now - this.lastSayAt < 800) return;
    this.lastSayAt = now;
    this.showBubble(SELF_ID, text, this.selfBubbleAnchor, { say: true });
    if (this.current.def.id !== PRIVATE_ROOM) this.presence?.sendSay(text);
  }

  private showBubble(owner: string, text: string, follow: Bubble["follow"], options: { say?: boolean; ms?: number } = {}) {
    this.bubbles.get(owner)?.container.destroy();
    const label = this.makeText(text, 5.5, "#1C1B19", 500, options.say ? SAY_WRAP : 0);
    const w = Math.ceil(label.width) + 10;
    const h = Math.max(11, Math.ceil(label.height) + 4);
    const g = this.add.graphics();
    g.fillStyle(0xfaf9f5, 0.96).fillRoundedRect(-w / 2, -h, w, h, 3);
    if (options.say) g.lineStyle(0.5, COLORS.brand, 1).strokeRoundedRect(-w / 2, -h, w, h, 3);
    // 气泡尾巴：容器原点在尾巴尖上方，多行气泡向上长
    g.fillTriangle(-2, -0.5, 2, -0.5, 0, 3);
    label.setY(-h / 2);
    const container = this.add.container(0, 0, [g, label]).setDepth(58000).setScale(0.6).setAlpha(0);
    this.tweens.add({ targets: container, scale: 1, alpha: 1, duration: 140, ease: "Back.easeOut" });
    const ms = options.ms ?? (options.say ? SAY_MS + text.length * SAY_MS_PER_CHAR : BUBBLE_MS);
    const bubble = { container, follow, until: this.time.now + ms };
    this.bubbles.set(owner, bubble);
    this.placeBubble(bubble);
  }

  // ---------- 猫 ----------

  /** 与猫互动：随机一种反应（不与上一次相同），自己冒泡并广播，其他人看到同样的反应 */
  private petCat(zone: Phaser.Geom.Rectangle) {
    const cat = this.nearestCat(zone.centerX, zone.centerY);
    const options = CAT_REACTIONS.filter(r => r !== this.lastCatReaction && !(r === "catrun" && cat && this.busyCats.has(cat)));
    const reaction = options[Math.floor(Math.random() * options.length)];
    const before = this.lastEmoteAt;
    this.emote(reaction);
    if (this.lastEmoteAt === before) return; // 冷却中
    this.lastCatReaction = reaction;
    if (cat) this.playCatReaction(cat, reaction);
  }

  private nearestCat(x: number, y: number): Phaser.GameObjects.Sprite | null {
    let best: Phaser.GameObjects.Sprite | null = null;
    let bestDist = 120;
    this.children.each(child => {
      if (!(child instanceof Phaser.GameObjects.Sprite) || child.texture.key !== "cat") return;
      const d = Phaser.Math.Distance.Between(x, y, child.x + child.width / 2, child.y + child.height / 2);
      if (d < bestDist) {
        bestDist = d;
        best = child;
      }
    });
    return best;
  }

  /** 在猫身上飘一串字符（爱心、Zzz），逐个上升淡出 */
  private floatAbove(cat: Phaser.GameObjects.Sprite, glyphs: string[], color: string, drift: number) {
    glyphs.forEach((glyph, i) => {
      const label = this.makeText(glyph, 6 + i * 0.6, color, 700)
        .setPosition(cat.x + cat.width / 2 + (i - 1) * 3, cat.y + 2)
        .setDepth(57000).setAlpha(0);
      this.tweens.add({
        targets: label,
        alpha: { from: 0, to: 1 },
        y: label.y - 14 - i * 3,
        x: label.x + drift * (i + 1),
        delay: i * 260,
        duration: 700,
        ease: "Sine.easeOut",
        onComplete: () => this.tweens.add({ targets: label, alpha: 0, duration: 400, onComplete: () => label.destroy() }),
      });
    });
  }

  private playCatReaction(cat: Phaser.GameObjects.Sprite, reaction: CatReaction) {
    switch (reaction) {
      case "catpurr":
        this.floatAbove(cat, ["♥", "♥", "♥"], "#FF7AA8", 0);
        break;
      case "catzzz":
        this.floatAbove(cat, ["z", "z", "Z"], "#FAF9F5", 2);
        break;
      case "catflip":
        // 翻个身：左右翻转并轻轻弹两下
        cat.setFlipX(!cat.flipX);
        this.tweens.add({ targets: cat, y: cat.y - 3, duration: 120, yoyo: true, repeat: 1, ease: "Sine.easeOut" });
        break;
      case "catmeow":
        this.showBubble(`cat-${cat.x}-${cat.y}`, "喵！", () => ({ x: cat.x + cat.width / 2, y: cat.y - 2, visible: cat.visible }), { ms: 1800 });
        break;
      case "catrun": {
        // 被吵醒：小跑到一旁，过一会儿再跑回来趴下
        if (this.busyCats.has(cat)) break;
        this.busyCats.add(cat);
        const home = { x: cat.x, y: cat.y, flip: cat.flipX };
        const away = home.x > this.current.def.x + this.current.def.width / 2 ? -46 : 46;
        const trot = (toX: number, done: () => void) => {
          cat.setFlipX(toX < cat.x);
          this.tweens.add({ targets: cat, y: home.y - 2, duration: 110, yoyo: true, repeat: 4 });
          this.tweens.add({ targets: cat, x: toX, duration: 1000, ease: "Sine.easeInOut", onComplete: done });
        };
        trot(home.x + away, () => {
          this.time.delayedCall(2600, () => trot(home.x, () => {
            cat.setFlipX(home.flip);
            cat.setY(home.y);
            this.busyCats.delete(cat);
          }));
        });
        break;
      }
    }
  }

  private placeBubble(bubble: Bubble) {
    const at = bubble.follow();
    bubble.container.setPosition(Math.round(at.x), Math.round(at.y)).setVisible(at.visible);
  }

  private updateBubbles() {
    const now = this.time.now;
    for (const [owner, bubble] of this.bubbles) {
      if (now > bubble.until) {
        bubble.container.destroy();
        this.bubbles.delete(owner);
      } else {
        this.placeBubble(bubble);
        if (bubble.until - now < 200) bubble.container.setAlpha((bubble.until - now) / 200);
      }
    }
  }

  /** 工位名牌：自己的工位显示品牌色「我的工位」，别人的显示名字，空闲工位不显示 */
  private refreshDeskTags() {
    this.deskVersion = this.bridge.desks.version;
    for (const tag of this.deskTags.values()) tag.destroy();
    this.deskTags.clear();
    for (const room of this.rooms.values()) {
      for (const desk of room.def.desks ?? []) {
        const claim = this.bridge.desks.claims[desk.id];
        if (!claim) continue;
        const tag = this.createSign(room.def.x + desk.signX, room.def.y + desk.signY, claim.mine ? "我的工位" : claim.name, claim.mine);
        this.deskTags.set(desk.id, tag);
      }
    }
    // 归属变化后，站在工位旁的提示文字随之更新
    const item = this.player ? this.findInteractable(this.player.x, this.player.y) : null;
    if (item?.desk && !this.player.isSeated) this.setNearby(this.describe(item));
  }

  // ---------- 多人同步 ----------

  private handlePresence(message: LobbyServerMessage) {
    if (this.destroyed) return;
    switch (message.type) {
      case "snapshot": {
        // 重连后以快照为准：快照里没有、也不在离场途中的角色直接移除
        const ids = new Set(message.players.map(p => p.id));
        for (const [id, remote] of this.remotes) {
          if (!ids.has(id) && !remote.leaving) this.removeRemote(id, false);
        }
        message.players.forEach(p => this.upsertRemote(p));
        break;
      }
      case "player":
        this.upsertRemote(message.player);
        break;
      case "move": {
        const remote = this.remotes.get(message.id);
        if (remote && this.rooms.has(message.room)) remote.push(message);
        break;
      }
      case "hide":
        // 自己走进了私有房间：此前同步的位置已在电梯 / 门口，淡出即可
        this.removeRemote(message.id, true);
        break;
      case "leave":
        this.walkHome(message.id);
        break;
      case "profile": {
        const remote = this.remotes.get(message.id);
        if (!remote) break;
        remote.setName(message.name);
        this.applyRemoteAvatar(remote, message.avatar);
        break;
      }
      case "emote": {
        const remote = this.remotes.get(message.id);
        const text = LOBBY_EMOTES[message.key]?.[0];
        if (!remote || !text) break;
        this.showBubble(message.id, text, this.remoteBubbleAnchor(remote));
        // 别人逗猫：同一房间里也看到猫的反应
        if ((CAT_REACTIONS as readonly string[]).includes(message.key) && remote.room === this.current.def.id) {
          const cat = this.nearestCat(remote.x, remote.y);
          if (cat) this.playCatReaction(cat, message.key as CatReaction);
        }
        break;
      }
      case "say": {
        const remote = this.remotes.get(message.id);
        if (remote) this.showBubble(message.id, message.text, this.remoteBubbleAnchor(remote), { say: true });
        break;
      }
      case "desks":
        this.events_.onDesksChanged?.();
        break;
      case "notes":
        // 留言板有新便签或删除：打开着的留言板面板自行刷新
        window.dispatchEvent(new CustomEvent(LOBBY_NOTES_EVENT));
        break;
    }
  }

  private upsertRemote(player: LobbyRemotePlayer) {
    const room = this.rooms.get(player.room);
    if (!room || player.room === PRIVATE_ROOM || typeof player.x !== "number" || typeof player.y !== "number") return;
    let remote = this.remotes.get(player.id);
    if (remote) {
      remote.setName(player.name);
      remote.push(player);
    } else {
      remote = new RemotePlayer(this, player.id, player.name, player, "player", this.makeNameTag);
      this.remotes.set(player.id, remote);
      // 在当前房间的电梯前出现：电梯开合一次，像是刚下楼
      if (room === this.current) {
        const arrived = Object.values(room.def.spawns).some(spawn => spawn.cycleDoor
          && Phaser.Math.Distance.Between(player.x, player.y, room.def.x + spawn.x, room.def.y + spawn.y) < ARRIVE_DISTANCE);
        if (arrived) this.cycleDoors(room);
      }
    }
    this.applyRemoteAvatar(remote, player.avatar);
  }

  private removeRemote(id: string, fade: boolean) {
    const remote = this.remotes.get(id);
    if (!remote) return;
    this.remotes.delete(id);
    this.bubbles.get(id)?.container.destroy();
    this.bubbles.delete(id);
    if (fade) remote.fadeOut();
    else remote.destroy();
  }

  /** 为其他人合成形象贴图；同款搭配共用一张，合成完成前先显示默认角色 */
  private applyRemoteAvatar(remote: RemotePlayer, avatar: LobbyAvatar | null) {
    if (!avatar) {
      remote.avatarKey = "";
      remote.setSkin("player");
      return;
    }
    const key = AVATAR_SLOTS.map(slot => avatar[slot] ?? "").join("|");
    remote.avatarKey = key;
    const ready = this.remoteSkins.get(key);
    if (ready) {
      remote.setSkin(ready);
      return;
    }
    if (this.remoteSkinPending.has(key)) return;
    this.remoteSkinPending.add(key);
    loadAvatarParts()
      .then(parts => {
        if (this.destroyed) return;
        const textureKey = `avatar-remote-${this.remoteSkins.size}`;
        const texture = this.createSheetTexture(textureKey);
        if (!texture?.context) return;
        texture.context.drawImage(composeAvatarSheet(parts, normalizeAvatar(parts, avatar)), 0, 0);
        texture.refresh();
        this.remoteSkins.set(key, textureKey);
        for (const other of this.remotes.values()) {
          if (other.avatarKey === key) other.setSkin(textureKey);
        }
      })
      .catch(() => undefined)
      .finally(() => this.remoteSkinPending.delete(key));
  }

  private navGrid(roomId: string): NavGrid {
    let grid = this.navGrids.get(roomId);
    if (!grid) {
      grid = new NavGrid(this.rooms.get(roomId)!.def);
      this.navGrids.set(roomId, grid);
    }
    return grid;
  }

  /** 按传送门连接关系找出从某房间到私有房间要依次经过的传送门 */
  private routeToPrivate(fromRoom: string): PortalDef[] | null {
    const previous = new Map<string, { room: string; portal: PortalDef }>();
    const queue = [fromRoom];
    const seen = new Set(queue);
    while (queue.length) {
      const roomId = queue.shift()!;
      if (roomId === PRIVATE_ROOM) {
        const hops: PortalDef[] = [];
        for (let at = roomId; at !== fromRoom;) {
          const step = previous.get(at)!;
          hops.unshift(step.portal);
          at = step.room;
        }
        return hops;
      }
      for (const portal of this.rooms.get(roomId)?.def.portals ?? []) {
        if (seen.has(portal.to) || !this.rooms.has(portal.to)) continue;
        seen.add(portal.to);
        previous.set(portal.to, { room: roomId, portal });
        queue.push(portal.to);
      }
    }
    return null;
  }

  /** 下线：让角色从当前位置自动走回私有房间（大厅 → 玻璃门 → 入口厅 → 电梯），走进去后淡出 */
  private walkHome(id: string) {
    const remote = this.remotes.get(id);
    if (!remote) return;
    const hops = this.routeToPrivate(remote.room);
    if (!hops || hops.length === 0) {
      this.removeRemote(id, true);
      return;
    }
    remote.leaving = true;
    const walkLeg = (roomId: string, from: Point, index: number) => {
      const room = this.rooms.get(roomId)!.def;
      const portal = hops[index];
      const grid = this.navGrid(roomId);
      const local = { x: from.x - room.x, y: from.y - room.y };
      const target = grid.targetIn(portal.rect);
      const path = target ? grid.findPath(local, target) : null;
      if (!path) {
        this.removeRemote(id, true);
        return;
      }
      remote.follow({
        room: roomId,
        points: path.map(p => ({ x: room.x + p.x, y: room.y + p.y })),
        onArrive: () => {
          if (this.remotes.get(id) !== remote) return;
          const next = this.rooms.get(portal.to)!;
          if (portal.to === PRIVATE_ROOM) {
            this.removeRemote(id, true);
            return;
          }
          const spawn = next.def.spawns[portal.spawn];
          const at = { x: next.def.x + spawn.x, y: next.def.y + spawn.y };
          remote.placeAt(portal.to, at, spawn.dir);
          walkLeg(portal.to, at, index + 1);
        },
      });
    };
    walkLeg(remote.room, { x: remote.x, y: remote.y }, 0);
  }

  /** React 打开机器面板或页面输入框获得焦点时暂停：冻结角色并停止拦截按键，
   *  让输入框可以正常输入 WASD/E/空格 */
  private syncPause() {
    const shouldPause = this.bridge.paused || isTyping();
    if (shouldPause === this.paused) return;
    this.paused = shouldPause;
    const keyboard = this.input.keyboard!;
    if (this.paused) {
      keyboard.enabled = false;
      keyboard.disableGlobalCapture();
      this.player.frozen = true;
    } else {
      keyboard.resetKeys();
      keyboard.enabled = true;
      keyboard.enableGlobalCapture();
      if (!this.transitioning) this.player.frozen = false;
    }
  }

  update(_time: number, delta: number) {
    if (this.failed || !this.player) return;
    this.syncPause();
    if (this.bridge.avatar.version !== this.avatarVersion) this.player.setSkin(this.applyAvatar());
    if (this.bridge.desks.version !== this.deskVersion) this.refreshDeskTags();
    this.player.update();
    if (this.bridge.emoteQueued) {
      const key = this.bridge.emoteQueued;
      this.bridge.emoteQueued = "";
      this.emote(key);
    }
    if (this.bridge.sayQueued) {
      const text = this.bridge.sayQueued;
      this.bridge.sayQueued = "";
      this.say(text);
    }

    // 坐着时按座位坐标上报与判定（侧坐的精灵是上移绘制的）
    const { x: feetX, y: feetY } = this.player.feet;
    const roomId = this.current.def.id;
    const seated = this.player.isSeated;
    this.presence?.report({
      room: roomId, x: feetX, y: feetY, dir: this.player.facingDir, moving: this.player.isMoving, pose: seated ? "sit" : "",
    });

    // 其他人：插值移动或自动离场；只显示与自己同一房间的人
    const actors: Point[] = [{ x: feetX, y: feetY }];
    for (const remote of this.remotes.values()) {
      remote.update(delta, roomId);
      if (remote.room === roomId) actors.push({ x: remote.x, y: remote.y });
    }

    // 门：任何人（自己或同房间的其他人）靠近自动打开，都离开后关闭
    for (const door of this.current.doors) {
      const near = this.time.now < door.holdUntil
        || actors.some(actor => Phaser.Math.Distance.Between(actor.x, actor.y, door.cx, door.cy) < door.def.radius);
      if (near !== door.open) {
        door.open = near;
        door.sprite.play(`${door.def.key}-${near ? "open" : "close"}`);
      }
    }

    this.updateBubbles();

    // 交互请求只在当帧有效：本帧不在交互区（或正在切换房间）时直接丢弃
    const interact = this.interactPressed || this.bridge.interactQueued;
    this.interactPressed = false;
    this.bridge.interactQueued = false;
    if (this.transitioning || this.paused) return;

    if (seated) {
      // 坐着：工位上按 E 重新打开（待办 / 认领），其他座位按 E 起身
      const desk = this.seatedDesk ? this.current.def.desks?.find(d => d.id === this.seatedDesk) : undefined;
      this.setNearby(desk
        ? { ...this.deskInfo(desk), hint: this.bridge.desks.claims[desk.id]?.mine ? "按 E 打开待办 · 方向键起身" : "方向键起身" }
        : { kind: "seat", id: "stand", title: "起身", hint: "或按方向键" });
      this.prompt.setVisible(false);
      if (interact) {
        if (desk) this.events_.onDesk?.(desk.id);
        else this.player.stand();
      }
      return;
    }

    const portal = this.current.portals.find(p => p.rect.contains(feetX, feetY));
    if (portal) {
      this.travel(portal.def);
      return;
    }

    const item = this.findInteractable(feetX, feetY);
    this.setNearby(item ? this.describe(item) : null);
    if (item) {
      this.prompt.setPosition(this.player.x, this.player.y - 40);
      if (interact) this.interact(item);
    }
  }
}
