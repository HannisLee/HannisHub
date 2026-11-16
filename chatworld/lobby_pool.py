"""聊天大厅台球桌：中式八球的入座、轮次与对局状态同步（经由大厅同步通道 /api/chat-lobby/ws）。

- 台球桌两端各一个球位（left / right）：两个不同账号分别入座即开局；单人练习时同一账号占两个球位，自己打自己
- 物理模拟与规则判定在击球方浏览器完成：击球方发送「击球参数 + 击球后的对局状态」，服务端校验轮次与格式后
  保存并转发给所有观看者；其他浏览器用相同参数做确定性回放，回放结束后以服务端转发的状态为准
- 服务端只信任「轮到谁」：只有当前轮次球位上的账号可以击球、发送瞄准；对局状态整体按白名单字段校验
- 球桌状态只放在内存中，不落盘；账号下线（最后一个连接断开且超过宽限期）时自动离座，对局中离座判负

协议（JSON 文本帧，均带 "type": "pool"，客户端字段 op）：
- 客户端 → 服务端：
  - {"op": "watch"} / {"op": "unwatch"}：打开 / 关闭台球面板，订阅球桌变化
  - {"op": "sit", "seat": "left" | "right"}：入座；两个球位都有人（不同账号）时开局
  - {"op": "solo"}：单人练习，占用两个球位（球桌空闲或只有自己时可用）
  - {"op": "leave"}：离座；双人对局进行中离座判负
  - {"op": "aim", "a", "p", "x"?, "y"?}：瞄准角度（弧度）、力度 0–1、摆放自由球时的白球坐标，只转发
  - {"op": "shot", "shot": {...}, "game": {...}}：击球参数与击球后的对局状态
  - {"op": "rematch"}：对局结束后申请再来一局，双方都申请（单人练习直接）后重新摆球
- 服务端 → 客户端：
  - {"type": "pool", "ev": "table", "table": 球桌}：入座、开局、结束等变化（发给观看者）
  - {"type": "pool", "ev": "shot", "shot", "game", "version"}：一杆的参数与结果（发给击球连接以外的观看者）
  - {"type": "pool", "ev": "aim", "a", "p", "x", "y"}：当前击球方的瞄准（发给击球连接以外的观看者）
  - {"type": "pool-summary", "left", "right", "status", "solo"}：球位上的名字与状态（发给所有连接，用于大厅提示）
  球桌 = {"seats": {"left": {"name"} | null, "right": ...}, "status": "open" | "playing" | "over", "solo",
          "game": 对局状态 | null, "version", "you": [自己占的球位], "rematch": [已申请再来一局的球位]}
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from chatworld.lobby_presence import Connection

SEATS = ("left", "right")
GROUPS = frozenset({"solid", "stripe"})
PHASES = frozenset({"break", "play", "over"})
# 球台内沿尺寸（毫米，与前端 frontend/components/chatworld/pool/table.ts 一致），坐标允许落在袋口内一点
TABLE_LENGTH = 2540.0
TABLE_WIDTH = 1270.0
COORD_MARGIN = 200.0
MAX_MSG_CHARS = 80
MAX_SPEED = 20_000.0
MAX_NAME_CHARS = 16


def _other(seat: str) -> str:
    return "right" if seat == "left" else "left"


def _num(value: Any, low: float, high: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value) if low <= value <= high else None


def new_rack() -> list[int]:
    """中式八球摆球顺序：三角形 15 个位置按行排列（顶点第 0 个），黑 8 居中（第 4 个），
    底边两角（第 10、14 个）一实一花，其余随机。"""
    solids = [1, 2, 3, 4, 5, 6, 7]
    stripes = [9, 10, 11, 12, 13, 14, 15]
    random.shuffle(solids)
    random.shuffle(stripes)
    corners = [solids.pop(), stripes.pop()]
    random.shuffle(corners)
    rest = solids + stripes
    random.shuffle(rest)
    rack: list[int] = []
    for index in range(15):
        if index == 4:
            rack.append(8)
        elif index == 10:
            rack.append(corners[0])
        elif index == 14:
            rack.append(corners[1])
        else:
            rack.append(rest.pop())
    return rack


def new_game(breaker: str) -> dict[str, Any]:
    """新一局：球的坐标由前端按 rack 计算，balls 为空表示尚未开球。"""
    return {
        "rack": new_rack(), "balls": None, "turn": breaker, "breaker": breaker, "phase": "break",
        "groups": {"left": None, "right": None}, "hand": True, "kitchen": True,
        "winner": None, "msg": "", "shots": 0, "last": None,
    }


def clean_game(data: Any) -> dict[str, Any] | None:
    """校验击球方发来的对局状态，只保留白名单字段；格式不对返回 None。"""
    if not isinstance(data, dict):
        return None
    rack = data.get("rack")
    if not (isinstance(rack, list) and sorted(rack) == list(range(1, 16))
            and all(isinstance(n, int) and not isinstance(n, bool) for n in rack)):
        return None
    balls = data.get("balls")
    cleaned_balls: list[list[float]] | None = None
    if balls is not None:
        if not isinstance(balls, list) or len(balls) > 16:
            return None
        cleaned_balls = []
        seen: set[int] = set()
        for item in balls:
            if not isinstance(item, list) or len(item) != 3:
                return None
            n = item[0]
            if isinstance(n, bool) or not isinstance(n, int) or not 0 <= n <= 15 or n in seen:
                return None
            x = _num(item[1], -COORD_MARGIN, TABLE_LENGTH + COORD_MARGIN)
            y = _num(item[2], -COORD_MARGIN, TABLE_WIDTH + COORD_MARGIN)
            if x is None or y is None:
                return None
            seen.add(n)
            cleaned_balls.append([n, round(x, 1), round(y, 1)])
    turn, breaker, phase = data.get("turn"), data.get("breaker"), data.get("phase")
    if turn not in SEATS or breaker not in SEATS or phase not in PHASES:
        return None
    groups = data.get("groups")
    if not isinstance(groups, dict) or any(groups.get(s) not in (None, *GROUPS) for s in SEATS):
        return None
    if groups["left"] is not None and groups["left"] == groups["right"]:
        return None
    winner = data.get("winner")
    if winner not in (None, *SEATS) or (phase == "over") != (winner is not None):
        return None
    shots = data.get("shots")
    if isinstance(shots, bool) or not isinstance(shots, int) or not 0 <= shots <= 100_000:
        return None
    msg = data.get("msg", "")
    if not isinstance(msg, str):
        return None
    last = data.get("last")
    cleaned_last = None
    if last is not None:
        if not isinstance(last, dict):
            return None
        pocketed = last.get("pocketed", [])
        foul = last.get("foul")
        if (not isinstance(pocketed, list) or len(pocketed) > 16
                or not all(isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 15 for n in pocketed)):
            return None
        if foul is not None and not isinstance(foul, str):
            return None
        cleaned_last = {"pocketed": pocketed, "foul": foul[:MAX_MSG_CHARS] if foul else None}
    return {
        "rack": rack, "balls": cleaned_balls, "turn": turn, "breaker": breaker, "phase": phase,
        "groups": {s: groups.get(s) for s in SEATS}, "hand": data.get("hand") is True,
        "kitchen": data.get("kitchen") is True, "winner": winner, "msg": msg[:MAX_MSG_CHARS],
        "shots": shots, "last": cleaned_last,
    }


def clean_shot(data: Any) -> dict[str, float] | None:
    """击球参数：白球初速度 (vx, vy)、上下旋 (sx, sy)、侧旋 w，以及击球时白球的位置 (cx, cy)（自由球摆放后的位置）。"""
    if not isinstance(data, dict):
        return None
    out: dict[str, float] = {}
    for key in ("vx", "vy", "sx", "sy", "w"):
        value = _num(data.get(key), -MAX_SPEED, MAX_SPEED)
        if value is None:
            return None
        out[key] = value
    cx = _num(data.get("cx"), 0, TABLE_LENGTH)
    cy = _num(data.get("cy"), 0, TABLE_WIDTH)
    if cx is None or cy is None:
        return None
    out["cx"], out["cy"] = cx, cy
    return out


@dataclass
class Seat:
    username: str
    name: str


@dataclass
class PoolTable:
    """大厅里唯一的一张台球桌；所有方法在事件循环线程中调用。

    send(conn, text) 把一条消息放入连接的发送队列；connections() 返回当前所有连接（用于广播摘要）。"""

    send: Callable[["Connection", str], None]
    connections: Callable[[], list["Connection"]]
    seats: dict[str, Seat | None] = field(default_factory=lambda: {"left": None, "right": None})
    solo: bool = False
    game: dict[str, Any] | None = None
    version: int = 0
    rematch: set[str] = field(default_factory=set)
    watchers: set["Connection"] = field(default_factory=set)

    # ---------- 视图 ----------

    @property
    def status(self) -> str:
        if self.game is None:
            return "open"
        return "over" if self.game.get("phase") == "over" else "playing"

    def _owned(self, username: str) -> list[str]:
        return [s for s in SEATS if self.seats[s] and self.seats[s].username == username]

    def view(self, username: str) -> dict[str, Any]:
        return {
            "seats": {s: ({"name": seat.name} if (seat := self.seats[s]) else None) for s in SEATS},
            "status": self.status,
            "solo": self.solo,
            "game": self.game,
            "version": self.version,
            "you": self._owned(username),
            "rematch": sorted(self.rematch),
        }

    def summary(self) -> dict[str, Any]:
        return {
            "type": "pool-summary",
            "left": self.seats["left"].name if self.seats["left"] else None,
            "right": self.seats["right"].name if self.seats["right"] else None,
            "status": self.status,
            "solo": self.solo,
        }

    def summary_text(self) -> str:
        return json.dumps(self.summary(), ensure_ascii=False)

    def _send_table(self, conn: "Connection") -> None:
        self.send(conn, json.dumps({"type": "pool", "ev": "table", "table": self.view(conn.username)}, ensure_ascii=False))

    def notify(self) -> None:
        """球位或对局变化：观看者收到完整球桌，所有连接收到摘要。"""
        for conn in list(self.watchers):
            self._send_table(conn)
        text = self.summary_text()
        for conn in self.connections():
            self.send(conn, text)

    # ---------- 状态变化 ----------

    def _start(self, breaker: str | None = None) -> None:
        self.game = new_game(breaker or random.choice(SEATS))
        self.version += 1
        self.rematch.clear()

    def _reset(self) -> None:
        self.seats = {"left": None, "right": None}
        self.solo = False
        self.game = None
        self.version += 1
        self.rematch.clear()

    def _sit(self, username: str, name: str, seat: Any) -> bool:
        if seat not in SEATS:
            return False
        current = self.seats[seat]
        if current and current.username == username and not self.solo:
            return False
        owned = self._owned(username)
        if self.solo:
            # 单人练习中：只有本人可以改为等人（释放另一个球位），别人不能抢座
            if current and current.username != username:
                return False
            self.seats[_other(seat)] = None
            self.solo = False
            self.game = None
            self.version += 1
            self.rematch.clear()
            return True
        if current is not None:
            return False
        if owned and self.status == "playing":
            # 对局中不能换座
            return False
        for s in owned:
            self.seats[s] = None
        self.seats[seat] = Seat(username, name)
        other = self.seats[_other(seat)]
        if other and other.username != username:
            self._start()
        elif self.game is not None:
            # 对手走了之后有人重新入座之前，旧对局作废
            self.game = None
            self.version += 1
            self.rematch.clear()
        return True

    def _solo(self, username: str, name: str) -> bool:
        if any(seat and seat.username != username for seat in self.seats.values()):
            return False
        self.seats = {"left": Seat(username, name), "right": Seat(username, name)}
        self.solo = True
        self._start("left")
        return True

    def release(self, username: str) -> bool:
        """离座：双人对局进行中离座判对手胜；单人练习直接清台。返回是否有变化。"""
        owned = self._owned(username)
        if not owned:
            return False
        if self.solo:
            self._reset()
            return True
        seat = owned[0]
        self.seats[seat] = None
        other = _other(seat)
        if self.status == "playing" and self.seats[other] and self.game is not None:
            self.game = {**self.game, "phase": "over", "winner": other, "msg": "对手离开球桌，判负"}
            self.version += 1
        elif self.seats[other] is None:
            self._reset()
        self.rematch.discard(seat)
        return True

    def rename(self, username: str, name: str) -> None:
        changed = False
        for seat in self.seats.values():
            if seat and seat.username == username and seat.name != name:
                seat.name = name[:MAX_NAME_CHARS]
                changed = True
        if changed:
            self.notify()

    def drop(self, conn: "Connection") -> None:
        self.watchers.discard(conn)

    # ---------- 消息入口 ----------

    def handle(self, conn: "Connection", name: str, data: dict[str, Any]) -> None:
        op = data.get("op")
        username = conn.username
        if op == "watch":
            self.watchers.add(conn)
            self._send_table(conn)
        elif op == "unwatch":
            self.watchers.discard(conn)
        elif op == "sit":
            self.watchers.add(conn)
            if self._sit(username, name[:MAX_NAME_CHARS], data.get("seat")):
                self.notify()
            else:
                self._send_table(conn)
        elif op == "solo":
            self.watchers.add(conn)
            if self._solo(username, name[:MAX_NAME_CHARS]):
                self.notify()
            else:
                self._send_table(conn)
        elif op == "leave":
            if self.release(username):
                self.notify()
        elif op == "aim":
            self._aim(conn, data)
        elif op == "shot":
            self._shot(conn, data)
        elif op == "rematch":
            self._rematch(username)

    def _turn_owner(self, username: str) -> bool:
        if self.status != "playing" or self.game is None:
            return False
        seat = self.seats[self.game["turn"]]
        return seat is not None and seat.username == username

    def _aim(self, conn: "Connection", data: dict[str, Any]) -> None:
        if not self._turn_owner(conn.username):
            return
        angle = _num(data.get("a"), -10.0, 10.0)
        power = _num(data.get("p"), 0.0, 1.0)
        if angle is None or power is None:
            return
        x = _num(data.get("x"), 0, TABLE_LENGTH)
        y = _num(data.get("y"), 0, TABLE_WIDTH)
        payload = {"type": "pool", "ev": "aim", "a": round(angle, 4), "p": round(power, 3),
                   "x": None if x is None or y is None else round(x, 1), "y": None if x is None or y is None else round(y, 1)}
        text = json.dumps(payload)
        for watcher in list(self.watchers):
            if watcher is not conn:
                self.send(watcher, text)

    def _shot(self, conn: "Connection", data: dict[str, Any]) -> None:
        if not self._turn_owner(conn.username) or self.game is None:
            self._send_table(conn)
            return
        shot = clean_shot(data.get("shot"))
        game = clean_game(data.get("game"))
        # balls 为 null 只允许出现在重新摆球（开球进黑 8、开球不合法）之后的开球阶段
        rerack_ok = game is not None and (game["balls"] is not None or game["phase"] == "break")
        if shot is None or game is None or not rerack_ok or game["shots"] != self.game["shots"] + 1:
            self._send_table(conn)
            return
        before = self.status
        self.game = game
        self.version += 1
        text = json.dumps({"type": "pool", "ev": "shot", "shot": shot, "game": game, "version": self.version}, ensure_ascii=False)
        for watcher in list(self.watchers):
            if watcher is not conn:
                self.send(watcher, text)
        if self.status != before:
            self.notify()

    def _rematch(self, username: str) -> None:
        if self.status != "over" or self.game is None:
            return
        owned = self._owned(username)
        if not owned:
            return
        self.rematch.update(owned)
        if all(self.seats[s] for s in SEATS) and self.rematch >= set(SEATS):
            # 上一局输的一方开球；单人练习左右轮换
            winner = self.game.get("winner")
            breaker = _other(winner) if winner in SEATS else random.choice(SEATS)
            if self.solo:
                breaker = _other(self.game.get("breaker", "right"))
            self._start(breaker)
        self.notify()
