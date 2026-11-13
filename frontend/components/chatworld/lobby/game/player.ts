import Phaser from "phaser";
import type { Facing, LobbyBridge } from "./layout";

const SPEED = 88;

/** 可操控像素人物：WASD/方向键 + 触屏方向垫，四方向行走与呼吸静止动画。
 *  贴图（皮肤）可切换：默认为付费包 Modern Interiors 预制角色 "player"，
 *  自定义形象为运行时合成的 "avatar-self"；两者帧布局相同（16x32 帧，每行 6 帧）。
 *  本地玩家自己不显示头顶名字。 */
export class Player extends Phaser.Physics.Arcade.Sprite {
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;
  private bridge: LobbyBridge;
  private facing: Facing = "down";
  private skin: string;
  /** 冻结时忽略输入（房间切换、面板打开） */
  frozen = false;

  constructor(scene: Phaser.Scene, x: number, y: number, bridge: LobbyBridge, skin = "player") {
    super(scene, x, y, skin, 0);
    this.skin = skin;
    this.bridge = bridge;
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setOrigin(0.5, 1);
    this.setCollideWorldBounds(true);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setSize(10, 6);
    body.setOffset(3, 26);

    const keyboard = scene.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.wasd = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    Player.createAnimations(scene, skin);
    this.anims.play(this.animKey("idle-down"));
  }

  /** 为某个皮肤贴图创建 8 组动画，键名形如 `player:walk-left` */
  static createAnimations(scene: Phaser.Scene, skin: string) {
    // 帧序：每行 6 帧，行序 静止(南/北/左/右) + 行走(南/北/左/右)
    const anims = scene.anims;
    const make = (name: string, row: number, frameRate: number) => {
      const key = `${skin}:${name}`;
      if (anims.exists(key)) return;
      const frames = Array.from({ length: 6 }, (_, i) => ({ key: skin, frame: row * 6 + i }));
      anims.create({ key, frames, frameRate, repeat: -1 });
    };
    make("idle-down", 0, 4);
    make("idle-up", 1, 4);
    make("idle-left", 2, 4);
    make("idle-right", 3, 4);
    make("walk-down", 4, 10);
    make("walk-up", 5, 10);
    make("walk-left", 6, 10);
    make("walk-right", 7, 10);
  }

  /** 当前朝向（多人同步上报用） */
  get facingDir(): Facing {
    return this.facing;
  }

  /** 本帧是否在走动（多人同步上报用） */
  get isMoving(): boolean {
    const body = this.body as Phaser.Physics.Arcade.Body;
    return body.velocity.x !== 0 || body.velocity.y !== 0;
  }

  private animKey(name: string) {
    return `${this.skin}:${name}`;
  }

  /** 切换皮肤，保留当前动作与朝向 */
  setSkin(skin: string) {
    if (skin === this.skin) return;
    const action = this.anims.currentAnim?.key.split(":")[1] ?? `idle-${this.facing}`;
    this.skin = skin;
    Player.createAnimations(this.scene, skin);
    this.anims.play(this.animKey(action), true);
  }

  /** 传送到指定位置并设定朝向（房间切换用），同时清零速度避免带入惯性 */
  teleport(x: number, y: number, dir: Facing) {
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.reset(x, y);
    this.facing = dir;
    this.anims.play(this.animKey(`idle-${dir}`), true);
    this.setDepth(y);
  }

  update() {
    if (this.frozen) {
      this.setVelocity(0, 0);
      const idle = this.animKey(`idle-${this.facing}`);
      if (this.anims.currentAnim?.key !== idle) this.anims.play(idle, true);
      return;
    }
    const touch = this.bridge.touch;
    const left = this.cursors.left.isDown || this.wasd.left.isDown || touch.x < 0;
    const right = this.cursors.right.isDown || this.wasd.right.isDown || touch.x > 0;
    const up = this.cursors.up.isDown || this.wasd.up.isDown || touch.y < 0;
    const down = this.cursors.down.isDown || this.wasd.down.isDown || touch.y > 0;

    let dx = (right ? 1 : 0) - (left ? 1 : 0);
    let dy = (down ? 1 : 0) - (up ? 1 : 0);
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    this.setVelocity(dx * SPEED, dy * SPEED);

    const moving = dx !== 0 || dy !== 0;
    // 朝向优先级：水平 > 垂直，斜向移动显示侧向动画
    if (dx < 0) this.facing = "left";
    else if (dx > 0) this.facing = "right";
    else if (dy < 0) this.facing = "up";
    else if (dy > 0) this.facing = "down";

    const target = this.animKey(`${moving ? "walk" : "idle"}-${this.facing}`);
    if (this.anims.currentAnim?.key !== target) this.anims.play(target, true);

    this.setDepth(this.y);
  }
}
