"""聊天大厅多人同步：通过 WebSocket 广播入口厅与大厅中每个账号的位置、朝向与行走状态。

- 只同步公共房间（入口厅 foyer、大厅 hall）；我的房间（room）为私有，只广播「进入私有房间」，不广播坐标
- 以登录账号为单位显示角色：同一账号多开标签页时，以最近有动作的连接为准，其余连接只接收别人、不重复显示自己
- 账号的最后一个连接断开后等待 LEAVE_GRACE_SECONDS 再广播下线，刷新页面不会让别人看到角色离开又出现；
  客户端收到下线后，让该角色自动走回私有房间再消失
- 在线状态只放在内存中，不写文件；服务重启后所有人重新连接即可恢复
- 对外只暴露随机生成的角色编号与显示名字，不暴露登录用户名

协议（JSON 文本帧）：
- 客户端 → 服务端：{"type": "state", "room", "x", "y", "dir", "moving"}，移动中约每 100ms 一次，静止时每 5 秒一次作为心跳
- 服务端 → 客户端：
  - {"type": "snapshot", "players": [玩家, ...]}：连接建立时发送当前公共房间内的其他人
  - {"type": "player", "player": 玩家}：某人出现在公共房间（首次进入或从私有房间下来）
  - {"type": "move", "id", "room", "x", "y", "dir", "moving"}：位置更新
  - {"type": "hide", "id"}：走进了自己的私有房间
  - {"type": "leave", "id"}：下线
  - {"type": "profile", "id", "name", "avatar"}：名字或形象变化
  玩家 = {"id", "name", "avatar", "room", "x", "y", "dir", "moving"}
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket
from starlette.concurrency import run_in_threadpool

from chatworld import lobby_profile

PUBLIC_ROOMS = frozenset({"foyer", "hall"})
PRIVATE_ROOMS = frozenset({"room"})
FACINGS = frozenset({"down", "up", "left", "right"})

MAX_CONNECTIONS = 200
MAX_MESSAGE_CHARS = 512
# 客户端静止时每 5 秒发一次心跳，超过该时长没有任何消息视为连接失效
IDLE_TIMEOUT_SECONDS = 30.0
# 最后一个连接断开后延迟广播下线，刷新页面或短暂断网重连不会触发「离开」
LEAVE_GRACE_SECONDS = 3.0
MAX_COORD = 100_000.0
SEND_QUEUE_SIZE = 256
# 每个连接每秒最多处理的消息数，超出部分直接丢弃
RATE_PER_SECOND = 30

CLOSE_FORBIDDEN = 4403
CLOSE_FULL = 4429


@dataclass(eq=False)
class Connection:
    """一个浏览器标签页的 WebSocket 连接。"""

    websocket: WebSocket
    username: str
    queue: asyncio.Queue[str | None] = field(default_factory=lambda: asyncio.Queue(maxsize=SEND_QUEUE_SIZE))
    # 该连接最近一次上报的状态
    state: dict[str, Any] | None = None
    # 最近一次状态发生变化的时间，主连接断开时据此挑选接替者
    active_at: float = 0.0
    rate_window: float = 0.0
    rate_count: int = 0


@dataclass(eq=False)
class Member:
    """一个在线账号：可能同时有多个连接，但只以主连接的状态显示一个角色。"""

    id: str
    username: str
    name: str
    avatar: dict[str, str] | None
    connections: list[Connection] = field(default_factory=list)
    primary: Connection | None = None
    # 是否已作为可见角色广播给其他人（位于公共房间）
    visible: bool = False
    leave_task: asyncio.Task[None] | None = None


def _parse_state(data: dict[str, Any]) -> dict[str, Any] | None:
    """校验客户端上报的状态；私有房间只保留房间编号。"""
    room = data.get("room")
    if room in PRIVATE_ROOMS:
        return {"room": room}
    if room not in PUBLIC_ROOMS:
        return None
    x, y = data.get("x"), data.get("y")
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    if not (math.isfinite(x) and math.isfinite(y) and 0 <= x <= MAX_COORD and 0 <= y <= MAX_COORD):
        return None
    facing = data.get("dir")
    return {
        "room": room,
        "x": round(float(x), 1),
        "y": round(float(y), 1),
        "dir": facing if facing in FACINGS else "down",
        "moving": data.get("moving") is True,
    }


class LobbyPresence:
    """在线角色登记与广播中心；所有方法都在事件循环线程中调用，无需加锁。"""

    def __init__(self) -> None:
        self.members: dict[str, Member] = {}
        # 角色编号在进程生命周期内对同一账号保持不变，重连后其他人看到的仍是同一个角色
        self.ids: dict[str, str] = {}
        self.connections: set[Connection] = set()

    # ---------- 序列化 ----------

    @staticmethod
    def _player(member: Member) -> dict[str, Any]:
        state = member.primary.state if member.primary and member.primary.state else {}
        return {"id": member.id, "name": member.name, "avatar": member.avatar, **state}

    def _snapshot(self, username: str) -> str:
        players = [
            self._player(m) for m in self.members.values()
            if m.visible and m.primary and m.primary.state and m.username != username
        ]
        return json.dumps({"type": "snapshot", "players": players}, ensure_ascii=False)

    # ---------- 发送 ----------

    def _enqueue(self, conn: Connection, text: str) -> None:
        """放入发送队列；队列满说明客户端长期收不动，直接断开让它重连。"""
        try:
            conn.queue.put_nowait(text)
        except asyncio.QueueFull:
            self._drop(conn)

    def _drop(self, conn: Connection) -> None:
        # 清空队列后放入结束标记，发送协程据此关闭连接
        while not conn.queue.empty():
            conn.queue.get_nowait()
        conn.queue.put_nowait(None)

    def _broadcast(self, member: Member, payload: dict[str, Any]) -> None:
        """发给除该账号自己以外的所有连接。"""
        text = json.dumps(payload, ensure_ascii=False)
        for conn in list(self.connections):
            if conn.username != member.username:
                self._enqueue(conn, text)

    async def _sender(self, conn: Connection) -> None:
        while True:
            text = await conn.queue.get()
            if text is None:
                with contextlib.suppress(Exception):
                    await conn.websocket.close()
                return
            await conn.websocket.send_text(text)

    # ---------- 状态变化 ----------

    def _publish(self, member: Member) -> None:
        """按主连接当前状态广播：进入公共房间、移动、或进入私有房间。"""
        state = member.primary.state if member.primary else None
        if not state:
            return
        if state["room"] in PUBLIC_ROOMS:
            if member.visible:
                self._broadcast(member, {"type": "move", "id": member.id, **state})
            else:
                member.visible = True
                self._broadcast(member, {"type": "player", "player": self._player(member)})
        elif member.visible:
            member.visible = False
            self._broadcast(member, {"type": "hide", "id": member.id})

    def _handle_state(self, conn: Connection, data: dict[str, Any]) -> None:
        state = _parse_state(data)
        member = self.members.get(conn.username)
        if state is None or member is None:
            return
        changed = state != conn.state
        conn.state = state
        if not changed:
            return
        conn.active_at = time.monotonic()
        # 有动作的连接接管显示：同账号多开时以最近操作的标签页为准
        member.primary = conn
        self._publish(member)

    def _attach(self, conn: Connection, profile: dict[str, Any]) -> Member:
        member = self.members.get(conn.username)
        if member is None:
            member_id = self.ids.setdefault(conn.username, secrets.token_hex(6))
            member = Member(id=member_id, username=conn.username, name=profile["name"], avatar=profile["avatar"])
            self.members[conn.username] = member
        if member.leave_task:
            member.leave_task.cancel()
            member.leave_task = None
        member.connections.append(conn)
        self.connections.add(conn)
        return member

    def _detach(self, conn: Connection) -> None:
        self.connections.discard(conn)
        member = self.members.get(conn.username)
        if member is None or conn not in member.connections:
            return
        member.connections.remove(conn)
        if member.primary is conn:
            # 主连接关闭：交给剩余连接中最近有动作的一个，其状态若不同会表现为一次瞬移
            # 没有其他连接时保留旧主连接，宽限期内新进入的人仍能在快照里看到该角色停在原地
            candidates = [c for c in member.connections if c.state]
            if candidates:
                member.primary = max(candidates, key=lambda c: c.active_at)
                self._publish(member)
        if not member.connections:
            member.leave_task = asyncio.create_task(self._leave_later(member))

    async def _leave_later(self, member: Member) -> None:
        await asyncio.sleep(LEAVE_GRACE_SECONDS)
        if member.connections or self.members.get(member.username) is not member:
            return
        del self.members[member.username]
        if member.visible:
            self._broadcast(member, {"type": "leave", "id": member.id})

    def update_profile(self, username: str, profile: dict[str, Any]) -> None:
        """名字或形象保存后通知其他人刷新该角色。"""
        member = self.members.get(username)
        if member is None:
            return
        member.name = profile["name"]
        member.avatar = profile["avatar"]
        if member.visible:
            self._broadcast(member, {"type": "profile", "id": member.id, "name": member.name, "avatar": member.avatar})

    def _allow(self, conn: Connection) -> bool:
        now = time.monotonic()
        if now - conn.rate_window >= 1.0:
            conn.rate_window = now
            conn.rate_count = 0
        conn.rate_count += 1
        return conn.rate_count <= RATE_PER_SECOND

    # ---------- 连接入口 ----------

    async def serve(self, websocket: WebSocket, username: str) -> None:
        """处理一个已通过鉴权的 WebSocket 连接，直到断开。"""
        if len(self.connections) >= MAX_CONNECTIONS:
            await websocket.close(code=CLOSE_FULL)
            return
        profile = await run_in_threadpool(lobby_profile.get_profile, username)
        await websocket.accept()
        conn = Connection(websocket=websocket, username=username)
        self._attach(conn, profile)
        conn.queue.put_nowait(self._snapshot(username))
        sender = asyncio.create_task(self._sender(conn))
        try:
            while not sender.done():
                text = await asyncio.wait_for(websocket.receive_text(), IDLE_TIMEOUT_SECONDS)
                if len(text) > MAX_MESSAGE_CHARS or not self._allow(conn):
                    continue
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(data, dict) and data.get("type") == "state":
                    self._handle_state(conn, data)
        except Exception:
            # 断开、超时、发送了二进制帧等都按断开处理
            pass
        finally:
            self._detach(conn)
            sender.cancel()
            with contextlib.suppress(BaseException):
                await sender
            with contextlib.suppress(Exception):
                await websocket.close()


presence = LobbyPresence()
