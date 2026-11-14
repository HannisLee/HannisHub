import Phaser from "phaser";
import type { LobbyLocalState } from "../../../../lib/chat-lobby";
import type { Facing } from "./layout";
import type { Point } from "./pathfinding";
import { Player } from "./player";

/** 与本地角色相同的行走速度（像素/秒），自动走回私有房间时使用 */
const WALK_SPEED = 88;
/** 插值延迟：按约 10 次/秒的上报频率，落后 150ms 渲染可以总在两帧已知位置之间插值 */
const INTERP_DELAY_MS = 150;
/** 两次上报相距超过该距离视为瞬移（换房间、多标签切换），不做插值 */
const TELEPORT_DISTANCE = 48;
const FADE_MS = 220;
const NAME_OFFSET_Y = 35;

interface Sample extends Point {
  t: number;
  dir: Facing;
  moving: boolean;
  /** 坐着：直接摆在座位上，不做插值 */
  sit: boolean;
}

/** 一段自动行走：在 room 内依次走过 points，走完后执行 onArrive（换房间或消失） */
export interface RouteLeg {
  room: string;
  points: Point[];
  onArrive: () => void;
}

/** 其他人的角色：无物理与键盘控制，按服务端推送的位置插值显示；头顶显示名字。
 *  下线后由场景规划路线，沿路线自动走回私有房间。 */
export class RemotePlayer {
  readonly id: string;
  readonly sprite: Phaser.GameObjects.Sprite;
  room: string;
  /** 正在自动离场（下线） */
  leaving = false;
  private label: Phaser.GameObjects.Container;
  private name: string;
  private skin: string;
  /** 形象去重键（同款搭配共用一张贴图） */
  avatarKey = "";
  private facing: Facing;
  private samples: Sample[] = [];
  private route: RouteLeg | null = null;
  private routeIndex = 0;
  private removed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    id: string,
    name: string,
    state: LobbyLocalState,
    skin: string,
    private readonly makeLabel: (name: string) => Phaser.GameObjects.Container,
  ) {
    this.id = id;
    this.name = name;
    this.room = state.room;
    this.facing = state.dir;
    this.skin = skin;
    Player.createAnimations(scene, skin);
    this.sprite = scene.add.sprite(state.x, state.y, skin, 0).setOrigin(0.5, 1).setDepth(state.y);
    this.sprite.anims.play(`${skin}:idle-${state.dir}`);
    this.label = makeLabel(name);
    this.samples = [{ t: scene.time.now, x: state.x, y: state.y, dir: state.dir, moving: state.moving, sit: state.pose === "sit" }];
    this.placeLabel();
    // 出现时淡入
    this.sprite.setAlpha(0);
    this.label.setAlpha(0);
    scene.tweens.add({ targets: [this.sprite, this.label], alpha: 1, duration: FADE_MS });
  }

  get x() {
    return this.sprite.x;
  }

  /** 脚底纵坐标（坐着时为座位坐标，不含侧坐的绘制上移） */
  get y() {
    const latest = this.samples[this.samples.length - 1];
    return !this.route && latest?.sit ? latest.y : this.sprite.y;
  }

  setName(name: string) {
    if (name === this.name || this.removed) return;
    this.name = name;
    const visible = this.label.visible;
    const alpha = this.label.alpha;
    this.label.destroy();
    this.label = this.makeLabel(name).setVisible(visible).setAlpha(alpha);
    this.placeLabel();
  }

  setSkin(skin: string) {
    if (skin === this.skin || this.removed) return;
    const action = this.sprite.anims.currentAnim?.key.split(":")[1] ?? `idle-${this.facing}`;
    this.skin = skin;
    Player.createAnimations(this.scene, skin);
    this.sprite.anims.play(`${skin}:${action}`, true);
  }

  /** 名字标签上方的高度（气泡放在名字之上） */
  static readonly BUBBLE_OFFSET_Y = NAME_OFFSET_Y + 7;

  /** 收到服务端位置：换房间或距离过远直接瞬移，否则加入插值队列；正在离场时取消离场（重新上线） */
  push(state: LobbyLocalState) {
    const now = this.scene.time.now;
    this.leaving = false;
    this.route = null;
    const last = this.samples[this.samples.length - 1];
    const jump = !last || state.room !== this.room
      || Math.hypot(state.x - last.x, state.y - last.y) > TELEPORT_DISTANCE;
    const sit = state.pose === "sit";
    const sample = { t: now, x: state.x, y: state.y, dir: state.dir, moving: state.moving, sit };
    this.room = state.room;
    // 坐下与起身都是瞬间换位（座位在家具上，起身回到坐下前的位置），不插值
    if (jump || sit || last?.sit) {
      this.samples = [sample];
      this.sprite.setPosition(state.x, state.y);
    } else {
      this.samples.push(sample);
      // 只保留最近 1 秒内的样本（至少两个）
      while (this.samples.length > 2 && this.samples[1].t < now - 1000) this.samples.shift();
    }
  }

  /** 开始自动行走一段路线 */
  follow(leg: RouteLeg) {
    this.route = leg;
    this.routeIndex = 0;
    this.room = leg.room;
  }

  /** 瞬移到某点（自动行走经过传送门进入下一个房间时） */
  placeAt(room: string, p: Point, dir: Facing) {
    this.room = room;
    this.facing = dir;
    this.sprite.setPosition(p.x, p.y);
    this.samples = [{ t: this.scene.time.now, x: p.x, y: p.y, dir, moving: false, sit: false }];
  }

  /** 淡出并销毁 */
  fadeOut(onDone?: () => void) {
    if (this.removed) return;
    this.removed = true;
    this.route = null;
    this.scene.tweens.add({
      targets: [this.sprite, this.label],
      alpha: 0,
      duration: FADE_MS,
      onComplete: () => {
        this.destroy();
        onDone?.();
      },
    });
  }

  destroy() {
    this.removed = true;
    this.sprite.destroy();
    this.label.destroy();
  }

  update(delta: number, visibleRoom: string) {
    if (this.removed && !this.sprite.active) return;
    const latest = this.samples[this.samples.length - 1];
    const seated = !this.route && Boolean(latest?.sit);
    if (seated) {
      this.facing = latest.dir;
      this.sprite.setPosition(latest.x, Player.seatDrawY(latest.y, latest.dir));
      Player.applyPose(this.sprite, this.skin, latest.dir, true);
    } else {
      if (this.sprite.isCropped) Player.applyPose(this.sprite, this.skin, this.facing, false);
      let moving: boolean;
      if (this.route) moving = this.walkRoute(delta);
      else moving = this.interpolate();
      const key = `${this.skin}:${moving ? "walk" : "idle"}-${this.facing}`;
      if (this.sprite.anims.currentAnim?.key !== key) this.sprite.anims.play(key, true);
    }
    // 侧坐时精灵上移绘制，遮挡深度仍按座位脚底
    this.sprite.setDepth(seated ? latest.y : this.sprite.y);
    const visible = this.room === visibleRoom;
    this.sprite.setVisible(visible);
    this.label.setVisible(visible);
    this.placeLabel();
  }

  private placeLabel() {
    this.label.setPosition(Math.round(this.sprite.x), Math.round(this.sprite.y - NAME_OFFSET_Y));
  }

  /** 当前所在房间是否可见（场景据此决定是否给该角色冒气泡） */
  get shown() {
    return this.sprite.visible && !this.removed;
  }

  /** 按渲染时刻（当前时刻减去插值延迟）在相邻两个样本之间线性插值 */
  private interpolate(): boolean {
    const samples = this.samples;
    const renderT = this.scene.time.now - INTERP_DELAY_MS;
    let a = samples[0];
    let b = samples[0];
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].t <= renderT) {
        a = samples[i];
        b = samples[i + 1] ?? samples[i];
        break;
      }
    }
    const span = b.t - a.t;
    const t = span > 0 ? Phaser.Math.Clamp((renderT - a.t) / span, 0, 1) : 1;
    this.sprite.setPosition(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    this.facing = (t >= 1 ? b : a).dir;
    // 插值段内有位移，或对方上报仍在走动，都显示行走动画
    return b !== a ? (b.x !== a.x || b.y !== a.y) || a.moving : b.moving && renderT - b.t < 300;
  }

  /** 沿路线匀速行走；走完当前段时执行到达回调 */
  private walkRoute(delta: number): boolean {
    const leg = this.route!;
    let budget = (WALK_SPEED * delta) / 1000;
    while (budget > 0 && this.routeIndex < leg.points.length) {
      const target = leg.points[this.routeIndex];
      const dx = target.x - this.sprite.x;
      const dy = target.y - this.sprite.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) this.facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
      if (dist <= budget) {
        this.sprite.setPosition(target.x, target.y);
        budget -= dist;
        this.routeIndex += 1;
      } else {
        this.sprite.setPosition(this.sprite.x + (dx / dist) * budget, this.sprite.y + (dy / dist) * budget);
        budget = 0;
      }
    }
    if (this.routeIndex >= leg.points.length) {
      this.route = null;
      leg.onArrive();
      return false;
    }
    return true;
  }
}
