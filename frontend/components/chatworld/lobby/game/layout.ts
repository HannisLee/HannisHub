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

/** React 与 Phaser 共享的可变桥接对象：React 写入，场景每帧读取，避免跨层重渲染 */
export interface LobbyBridge {
  touch: { x: number; y: number };
  /** 自定义形象：合成好的 96x256 帧表（null 时使用默认角色）；version 变化时场景重新贴图 */
  avatar: { sheet: HTMLCanvasElement | null; version: number };
  /** 机器面板打开时为 true：角色冻结，键盘释放给页面输入框 */
  paused: boolean;
  /** 触屏「使用」按钮按下后置 true，场景消费后复位 */
  interactQueued: boolean;
}

export interface LobbyEvents {
  onProgress?: (value: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  onRoomChange?: (room: RoomInfo) => void;
  onNearby?: (machine: MachineInfo | null) => void;
  onInteract?: (machine: MachineInfo) => void;
}
