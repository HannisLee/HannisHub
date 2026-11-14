import { lobbySocketUrl, type LobbyLocalState, type LobbyServerMessage } from "../../../../lib/chat-lobby";

/** 位置变化时最短发送间隔（约 10 次/秒） */
const SEND_INTERVAL_MS = 100;
/** 静止时的心跳间隔：服务端 30 秒收不到消息会断开 */
const KEEPALIVE_MS = 5000;
const MAX_RETRY_DELAY_MS = 10_000;
/** 未登录 / 无权限：不再重连 */
const CLOSE_CODES_FATAL = new Set([4401, 4403]);

/** 状态去重键：私有房间只看房间编号，公共房间坐标取整，避免亚像素抖动反复发送 */
function stateKey(state: LobbyLocalState): string {
  if (state.room === "room") return state.room;
  return `${state.room}|${Math.round(state.x)}|${Math.round(state.y)}|${state.dir}|${state.moving ? 1 : 0}|${state.pose ?? ""}`;
}

/** 聊天大厅多人同步连接：节流上报自己的状态，断线后指数退避重连。
 *  场景每帧调用 report()，是否真正发送由这里决定。 */
export class PresenceClient {
  private socket: WebSocket | null = null;
  private destroyed = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private latest: LobbyLocalState | null = null;
  private sentKey = "";
  private sentAt = 0;

  constructor(private readonly onMessage: (message: LobbyServerMessage) => void) {
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(lobbySocketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      // 新连接立即上报一次当前状态
      this.sentKey = "";
      this.flush(true);
    };
    socket.onmessage = event => {
      if (typeof event.data !== "string") return;
      try {
        this.onMessage(JSON.parse(event.data) as LobbyServerMessage);
      } catch {
        // 忽略无法解析的消息
      }
    };
    socket.onclose = event => {
      if (this.socket === socket) this.socket = null;
      if (!CLOSE_CODES_FATAL.has(event.code)) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.destroyed || this.retryTimer) return;
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** this.retry);
    this.retry += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /** 记录最新状态，按节流规则决定是否发送 */
  report(state: LobbyLocalState) {
    this.latest = state;
    this.flush(false);
  }

  private flush(force: boolean) {
    const socket = this.socket;
    const state = this.latest;
    if (!socket || socket.readyState !== WebSocket.OPEN || !state) return;
    const now = performance.now();
    const key = stateKey(state);
    const due = key !== this.sentKey ? now - this.sentAt >= SEND_INTERVAL_MS : now - this.sentAt >= KEEPALIVE_MS;
    if (!force && !due) return;
    const payload = state.room === "room"
      ? { type: "state", room: state.room }
      : {
        type: "state",
        room: state.room,
        x: Math.round(state.x * 10) / 10,
        y: Math.round(state.y * 10) / 10,
        dir: state.dir,
        moving: state.moving,
        ...(state.pose ? { pose: state.pose } : {}),
      };
    socket.send(JSON.stringify(payload));
    this.sentKey = key;
    this.sentAt = now;
  }

  /** 发送表情：只在连接打开时发送，断线期间的表情直接丢弃（气泡是即时的，补发没有意义） */
  sendEmote(key: string) {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "emote", key }));
  }

  /** 发送说话气泡（回车输入的一句话），规则同表情 */
  sendSay(text: string) {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "say", text }));
  }

  destroy() {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
  }
}
