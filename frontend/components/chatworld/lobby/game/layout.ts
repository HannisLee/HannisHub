/** 聊天大厅布局数据类型：对应 scripts/build_chat_lobby_assets.py 输出的 public/chat-lobby/club/layout.json。
 *  房间内坐标均为房间局部像素坐标（TILE=16），运行时加上房间在世界中的偏移 x/y。 */

export const ASSET_BASE = "/chat-lobby/club";

/** 带版本号的素材地址；清单文件（layout.json、parts.json）本身每次都重新获取 */
export function assetUrl(file: string, build?: string): string {
  return build ? `${ASSET_BASE}/${file}?v=${encodeURIComponent(build)}` : `${ASSET_BASE}/${file}`;
}

/** [x, y, w, h] 矩形 */
export type Rect = [number, number, number, number];

export type Facing = "down" | "up" | "left" | "right";

export interface PropDef {
  /** objects 图集中的帧名 */
  key: string;
  x: number;
  y: number;
  solid?: Rect;
  /** 渲染深度（房间局部 y）；缺省按贴图底边 */
  depth?: number;
}

export interface AnimDef {
  key: string;
  x: number;
  y: number;
  depth?: number;
  solid?: Rect;
  /** "once"：不自动循环，由场景在特定时机播放一次（如电梯开合） */
  frames?: "once";
}

export interface PortalDef {
  rect: Rect;
  to: string;
  spawn: string;
}

export interface SpawnDef {
  x: number;
  y: number;
  dir: Facing;
  /** 到达该出生点时，房间里的自动门（电梯）开合一次，营造「刚到达」的感觉 */
  cycleDoor?: boolean;
}

export interface MachineDef {
  id: string;
  title: string;
  hint: string;
  /** 交互地台：角色脚底进入该区域即可按 E */
  zone: Rect;
  signX: number;
  signY: number;
}

/** 可坐的位置：(x, y) 为坐下后的脚底坐标（决定前后遮挡），dir 为坐下后的朝向；站进 zone 按 E 坐下 */
export interface SeatDef {
  id: string;
  x: number;
  y: number;
  dir: Facing;
  zone: Rect;
  title: string;
  /** 坐下后顺带演奏的乐器（钢琴凳） */
  play?: "piano";
}

/** 工位：可认领；认领者坐到自己的工位上打开待办 */
export interface DeskDef {
  id: string;
  zone: Rect;
  seat: { x: number; y: number; dir: Facing };
  /** 工位名牌位置 */
  signX: number;
  signY: number;
}

/** 小互动：按 E 在头顶冒出一句气泡（咖啡、喂鱼、撸猫……），sound 为附带的短旋律 */
export interface ActionDef {
  id: string;
  title: string;
  hint: string;
  zone: Rect;
  sound?: "guitar";
}

export interface DoorDef {
  key: string;
  x: number;
  y: number;
  /** 角色脚底距门底中心小于该半径时自动开门 */
  radius: number;
  /** 渲染深度（房间局部 y）；缺省按贴图底边。电梯用较小值，角色走进去时画在门上 */
  depth?: number;
}

export interface SignDef {
  x: number;
  y: number;
  text: string;
  tone: "brand" | "muted";
}

export interface RoomDef {
  id: string;
  name: string;
  /** 房间左上角在世界中的位置 */
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  walls: Rect[];
  props: PropDef[];
  anims: AnimDef[];
  portals: PortalDef[];
  spawns: Record<string, SpawnDef>;
  machines: MachineDef[];
  doors: DoorDef[];
  signs: SignDef[];
  seats?: SeatDef[];
  desks?: DeskDef[];
  actions?: ActionDef[];
}

export interface AnimSheetDef {
  file: string;
  frameWidth: number;
  frameHeight: number;
  frameRate: number;
  /** 自动门：开门 / 关门的帧序列 */
  door?: { open: number[]; close: number[] };
}

export interface LobbyLayout {
  version: number;
  /** 素材内容哈希：其余素材地址带 ?v=build，重新构建后不会混用缓存的旧图集 */
  build?: string;
  tile: number;
  world: { width: number; height: number };
  start: { room: string; spawn: string };
  anims: Record<string, AnimSheetDef>;
  rooms: RoomDef[];
}

/** 推送给 React 的房间与机器摘要 */
export interface RoomInfo {
  id: string;
  name: string;
}

export interface MachineInfo {
  id: string;
  title: string;
  hint: string;
}

/** 角色附近可交互对象的种类：machine 打开功能面板，desk 工位，seat 坐下，action 小互动 */
export type InteractKind = "machine" | "desk" | "seat" | "action";

export interface NearbyInfo extends MachineInfo {
  kind: InteractKind;
}

/** 工位归属（React 从接口读取后写入桥接对象）：name 为认领者在大厅中的名字，mine 表示自己的工位 */
export interface DeskClaim {
  name: string;
  mine: boolean;
}

/** React 与 Phaser 共享的可变桥接对象：React 写入，场景每帧读取，避免跨层重渲染 */
export interface LobbyBridge {
  touch: { x: number; y: number };
  /** 自定义形象：合成好的 96x320 帧表（null 时使用默认角色）；version 变化时场景重新贴图 */
  avatar: { sheet: HTMLCanvasElement | null; version: number };
  /** 机器面板打开时为 true：角色冻结，键盘释放给页面输入框 */
  paused: boolean;
  /** 触屏「使用」按钮按下后置 true，场景消费后复位 */
  interactQueued: boolean;
  /** 出生房间与出生点；null 时使用 layout.json 的默认入口（入口厅） */
  start: { room: string; spawn: string } | null;
  /** 工位归属：工位编号 → 认领信息；version 变化时场景刷新工位名牌 */
  desks: { claims: Record<string, DeskClaim>; version: number };
  /** 快捷表情（数字键或触屏按钮）：React 写入表情键，场景消费后清空 */
  emoteQueued: string;
  /** 回车输入的一句话：React 写入，场景在头顶显示并广播后清空 */
  sayQueued: string;
}

export interface LobbyEvents {
  onProgress?: (value: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  onRoomChange?: (room: RoomInfo) => void;
  onNearby?: (target: NearbyInfo | null) => void;
  onInteract?: (machine: MachineInfo) => void;
  /** 在工位坐下：React 按归属决定打开待办、询问认领或仅提示 */
  onDesk?: (deskId: string) => void;
  /** 有人认领或退还了工位：React 重新读取工位归属 */
  onDesksChanged?: () => void;
}
