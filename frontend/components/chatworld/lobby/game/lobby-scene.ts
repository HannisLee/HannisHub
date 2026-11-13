import Phaser from "phaser";
import {
  ASSET_BASE, assetUrl, type DoorDef, type LobbyBridge, type LobbyEvents, type LobbyLayout, type MachineDef,
  type PortalDef, type Rect, type RoomDef,
} from "./layout";
import { FRAME_HEIGHT, FRAME_WIDTH, SHEET_HEIGHT, SHEET_WIDTH } from "./avatar";
import { Player } from "./player";

/** 世界坐标下的房间：在布局数据基础上附加偏移后的矩形，便于判定 */
interface RuntimeRoom {
  def: RoomDef;
  portals: { def: PortalDef; rect: Phaser.Geom.Rectangle }[];
  machines: { def: MachineDef; rect: Phaser.Geom.Rectangle }[];
  doors: { def: DoorDef; sprite: Phaser.GameObjects.Sprite; cx: number; cy: number; open: boolean }[];
  onceAnims: Phaser.GameObjects.Sprite[];
}

const FADE_MS = 220;
/** 自定义形象贴图键：一张常驻的画布贴图，形象变化时重绘并刷新，已有动画与精灵无需重建 */
const AVATAR_TEXTURE = "avatar-self";
const CAMERA_MARGIN = 12;
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
  private nearby: MachineDef | null = null;
  /** 交互键按下标记：在 keydown 事件里置位，避免按下与抬起落在同一帧时 JustDown 丢失快速轻按 */
  private interactPressed = false;
  private prompt!: Phaser.GameObjects.Container;
  private transitioning = false;
  private paused = false;
  private failed = false;
  private avatarVersion = -1;

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

    const start = this.rooms.get(this.layout.start.room)!;
    const spawn = start.def.spawns[this.layout.start.spawn];
    this.createAvatarTexture();
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
    this.prompt = this.createPrompt();

    this.cameras.main.setBackgroundColor("#141413");
    this.enterRoom(start);
    this.scale.on("resize", this.applyCamera, this);

    // 初次进入：电梯开合一次，营造「刚到达」的感觉
    this.time.delayedCall(250, () => start.onceAnims.forEach(sprite => sprite.play(`anim-${sprite.texture.key}`)));
    this.cameras.main.fadeIn(400, 20, 20, 19);
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

  /** 创建 96x256 的画布贴图并切出 48 帧（与 player.png 相同布局） */
  private createAvatarTexture() {
    if (this.textures.exists(AVATAR_TEXTURE)) this.textures.remove(AVATAR_TEXTURE);
    const texture = this.textures.createCanvas(AVATAR_TEXTURE, SHEET_WIDTH, SHEET_HEIGHT);
    if (!texture) return;
    const columns = SHEET_WIDTH / FRAME_WIDTH;
    const count = columns * (SHEET_HEIGHT / FRAME_HEIGHT);
    for (let i = 0; i < count; i++) {
      texture.add(i, 0, (i % columns) * FRAME_WIDTH, Math.floor(i / columns) * FRAME_HEIGHT, FRAME_WIDTH, FRAME_HEIGHT);
    }
    texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
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
    for (const anim of def.anims) {
      const sprite = this.add.sprite(ox + anim.x, oy + anim.y, anim.key, 0).setOrigin(0);
      sprite.setDepth(oy + (anim.depth ?? anim.y + sprite.height));
      if (anim.frames === "once") onceAnims.push(sprite);
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
      return { def: door, sprite, cx: ox + door.x + sprite.width / 2, cy: oy + door.y + sprite.height, open: false };
    });

    for (const sign of def.signs) this.createSign(ox + sign.x, oy + sign.y, sign.text, sign.tone === "brand");
    for (const machine of def.machines) this.createMachineSign(ox + machine.signX, oy + machine.signY, machine);

    const toRect = ([x, y, w, h]: Rect) => new Phaser.Geom.Rectangle(ox + x, oy + y, w, h);
    return {
      def,
      portals: def.portals.map(portal => ({ def: portal, rect: toRect(portal.rect) })),
      machines: def.machines.map(machine => ({ def: machine, rect: toRect(machine.zone) })),
      doors,
      onceAnims,
    };
  }

  private makeText(text: string, size: number, color: string, weight = 500) {
    const label = this.add.text(0, 0, text, {
      fontFamily: LABEL_FONT,
      fontSize: `${size}px`,
      fontStyle: String(weight),
      color,
      resolution: TEXT_RESOLUTION,
    });
    label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    return label.setOrigin(0.5, 0.5);
  }

  /** 墙上的小型标牌（如入口厅品牌、出口方向） */
  private createSign(x: number, y: number, text: string, brand: boolean) {
    const label = this.makeText(text, brand ? 6 : 5.5, brand ? COLORS.text : COLORS.muted);
    const w = Math.ceil(label.width) + 10;
    const h = 10;
    const g = this.add.graphics();
    g.fillStyle(COLORS.surface, 0.92).fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(0.5, brand ? COLORS.brand : COLORS.border, 1).strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    this.add.container(x, y, [g, label]).setDepth(50000);
  }

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
      cam.fadeIn(FADE_MS + 60, 20, 20, 19);
      this.time.delayedCall(FADE_MS, () => {
        this.transitioning = false;
        this.player.frozen = this.paused;
      });
    });
  }

  private setNearby(machine: MachineDef | null) {
    if (this.nearby?.id === machine?.id) return;
    this.nearby = machine;
    this.prompt.setVisible(Boolean(machine));
    this.events_.onNearby?.(machine ? { id: machine.id, title: machine.title, hint: machine.hint } : null);
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

  update() {
    if (this.failed || !this.player) return;
    this.syncPause();
    if (this.bridge.avatar.version !== this.avatarVersion) this.player.setSkin(this.applyAvatar());
    this.player.update();

    const feetX = this.player.x;
    const feetY = this.player.y;

    // 门：角色靠近自动打开，离开后关闭
    for (const door of this.current.doors) {
      const near = Phaser.Math.Distance.Between(feetX, feetY, door.cx, door.cy) < door.def.radius;
      if (near !== door.open) {
        door.open = near;
        door.sprite.play(`${door.def.key}-${near ? "open" : "close"}`);
      }
    }

    // 交互请求只在当帧有效：本帧不在机器地台上（或正在切换房间）时直接丢弃
    const interact = this.interactPressed || this.bridge.interactQueued;
    this.interactPressed = false;
    this.bridge.interactQueued = false;
    if (this.transitioning || this.paused) return;

    const portal = this.current.portals.find(p => p.rect.contains(feetX, feetY));
    if (portal) {
      this.travel(portal.def);
      return;
    }

    const machine = this.current.machines.find(m => m.rect.contains(feetX, feetY))?.def ?? null;
    this.setNearby(machine);
    if (machine) {
      this.prompt.setPosition(this.player.x, this.player.y - 40);
      if (interact) this.events_.onInteract?.({ id: machine.id, title: machine.title, hint: machine.hint });
    }
  }
}
