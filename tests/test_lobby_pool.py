"""聊天大厅台球桌（中式八球）：入座开局、单人练习、轮次校验、对局状态校验、离座判负、再来一局与下线离座。
只在内存中运行，不读写线上 data/。"""
import json
import unittest

from chatworld import lobby_pool, lobby_presence


class _FakeSocket:
    async def close(self, *args, **kwargs):
        pass


def _shot():
    return {"vx": 1000.0, "vy": 0.0, "sx": 0.0, "sy": 0.0, "w": 0.0, "cx": 500.0, "cy": 635.0}


def _next_game(game, **changes):
    """模拟击球方上传的新状态：在旧状态上开过一杆。"""
    balls = [[0, 500.0, 635.0]] + [[n, 1900.0 + i * 10, 600.0] for i, n in enumerate(game["rack"])]
    data = {**game, "balls": balls, "phase": "play", "hand": False, "kitchen": False, "shots": game["shots"] + 1,
            "last": {"pocketed": [], "foul": None}, "msg": "开球未进球，轮到对方"}
    data.update(changes)
    return data


class PoolTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hub = lobby_presence.LobbyPresence()
        self.pool = self.hub.pool

    def _join(self, username):
        conn = lobby_presence.Connection(websocket=_FakeSocket(), username=username)
        self.hub._attach(conn, {"name": username.title(), "avatar": None})
        return conn

    @staticmethod
    def _drain(conn):
        items = []
        while not conn.queue.empty():
            items.append(json.loads(conn.queue.get_nowait()))
        return items

    def _send(self, conn, **data):
        self.hub._handle_pool(conn, {"type": "pool", **data})

    def _table(self, conn):
        tables = [m["table"] for m in self._drain(conn) if m.get("ev") == "table"]
        return tables[-1] if tables else None

    def test_rack_rules(self):
        for _ in range(50):
            rack = lobby_pool.new_rack()
            self.assertEqual(sorted(rack), list(range(1, 16)))
            self.assertEqual(rack[4], 8)
            self.assertEqual({rack[10] < 8, rack[14] < 8}, {True, False})

    def test_two_players_start_and_turns(self):
        a, b, c = self._join("alice"), self._join("bob"), self._join("carol")
        self._send(a, op="sit", seat="left")
        table = self._table(a)
        self.assertEqual(table["status"], "open")
        self.assertEqual(table["you"], ["left"])
        # 摘要发给所有连接（大厅提示用）
        self.assertEqual([m for m in self._drain(c) if m["type"] == "pool-summary"][-1]["left"], "Alice")
        # 已有人的球位不能抢
        self._send(c, op="sit", seat="left")
        self.assertEqual(self._table(c)["seats"]["left"], {"name": "Alice"})
        self._send(b, op="sit", seat="right")
        table = self._table(b)
        self.assertEqual(table["status"], "playing")
        self.assertEqual(table["you"], ["right"])
        game = table["game"]
        self.assertIsNone(game["balls"])
        turn = game["turn"]
        shooter, waiter = (a, b) if turn == "left" else (b, a)
        self._drain(a), self._drain(b), self._drain(c)
        # 不在轮次上的人不能击球、不能发瞄准
        self._send(waiter, op="shot", shot=_shot(), game=_next_game(game, turn=turn))
        self.assertEqual(self.pool.game["shots"], 0)
        self._send(waiter, op="aim", a=0.5, p=0.3)
        self.assertEqual([m for m in self._drain(shooter) if m.get("ev") == "aim"], [])
        # 观众（打开面板）收到瞄准与击球
        self._send(c, op="watch")
        self._drain(c)
        self._send(shooter, op="aim", a=0.5, p=0.3, x=400, y=600)
        aim = [m for m in self._drain(c) if m.get("ev") == "aim"]
        self.assertEqual(aim, [{"type": "pool", "ev": "aim", "a": 0.5, "p": 0.3, "x": 400.0, "y": 600.0}])
        other = "right" if turn == "left" else "left"
        self._send(shooter, op="shot", shot=_shot(), game=_next_game(game, turn=other))
        self.assertEqual(self.pool.game["turn"], other)
        shots = [m for m in self._drain(c) if m.get("ev") == "shot"]
        self.assertEqual(len(shots), 1)
        self.assertEqual(shots[0]["version"], self.pool.version)
        # 击球方自己的连接不重复收到
        self.assertEqual([m for m in self._drain(shooter) if m.get("ev") == "shot"], [])
        self.assertEqual(len([m for m in self._drain(waiter) if m.get("ev") == "shot"]), 1)

    def test_shot_validation(self):
        a, b = self._join("alice"), self._join("bob")
        self._send(a, op="sit", seat="left")
        self._send(b, op="sit", seat="right")
        game = self.pool.game
        shooter = a if game["turn"] == "left" else b
        bad_games = [
            _next_game(game, shots=5),  # 杆数不连续
            _next_game(game, balls=[[0, 1, 1], [0, 2, 2]]),  # 重复球号
            _next_game(game, balls=[[0, 99999, 1]]),  # 坐标越界
            _next_game(game, groups={"left": "solid", "right": "solid"}),
            _next_game(game, phase="over"),  # 结束必须有胜者
            _next_game(game, rack=[1] * 15),
            _next_game(game, turn="middle"),
        ]
        for bad in bad_games:
            self._send(shooter, op="shot", shot=_shot(), game=bad)
            self.assertEqual(self.pool.game["shots"], 0)
        self._send(shooter, op="shot", shot=_shot(), game=_next_game(game, balls=None))  # 非开球阶段不能清空球
        self.assertEqual(self.pool.game["shots"], 0)
        bad_shot = {**_shot(), "vx": float("inf")}
        self._send(shooter, op="shot", shot=bad_shot, game=_next_game(game))
        self.assertEqual(self.pool.game["shots"], 0)
        # 开球不合法重新摆球：balls 为 null、仍是开球阶段，可以接受
        rerack = {**game, "rack": lobby_pool.new_rack(), "balls": None, "shots": 1, "turn": "right", "breaker": "right",
                  "msg": "开球不合法，换对方重新开球", "last": {"pocketed": [], "foul": "开球不合法"}}
        self._send(shooter, op="shot", shot=_shot(), game=rerack)
        self.assertEqual(self.pool.game["shots"], 1)
        self.assertIsNone(self.pool.game["balls"])
        game = self.pool.game
        shooter = a if game["turn"] == "left" else b
        # 消息字段被截断、多余字段丢弃
        good = _next_game(game, msg="很长" * 100, extra="x")
        self._send(shooter, op="shot", shot=_shot(), game=good)
        self.assertEqual(self.pool.game["shots"], 2)
        self.assertNotIn("extra", self.pool.game)
        self.assertLessEqual(len(self.pool.game["msg"]), lobby_pool.MAX_MSG_CHARS)

    def test_solo_practice(self):
        a, b = self._join("alice"), self._join("bob")
        self._send(a, op="solo")
        table = self._table(a)
        self.assertTrue(table["solo"])
        self.assertEqual(table["you"], ["left", "right"])
        self.assertEqual(table["status"], "playing")
        # 别人不能加入单人练习，也不能发起单人练习
        self._send(b, op="sit", seat="right")
        self._send(b, op="solo")
        self.assertTrue(self.pool.solo)
        self.assertEqual(self.pool.seats["right"].username, "alice")
        # 两边都能击球
        game = self.pool.game
        self._send(a, op="shot", shot=_shot(), game=_next_game(game, turn="right"))
        self._send(a, op="shot", shot=_shot(), game=_next_game(self.pool.game, turn="left"))
        self.assertEqual(self.pool.game["shots"], 2)
        # 获胜后再来一局直接开始，开球方轮换
        self._send(a, op="shot", shot=_shot(), game=_next_game(self.pool.game, phase="over", winner="left"))
        self.assertEqual(self.pool.status, "over")
        self._send(a, op="rematch")
        self.assertEqual(self.pool.status, "playing")
        self.assertEqual(self.pool.game["breaker"], "right")
        # 离座清台
        self._send(a, op="leave")
        self.assertEqual(self.pool.status, "open")
        self.assertEqual(self.pool.seats, {"left": None, "right": None})

    def test_solo_back_to_waiting(self):
        a = self._join("alice")
        self._send(a, op="solo")
        self._send(a, op="sit", seat="left")
        self.assertFalse(self.pool.solo)
        self.assertEqual(self.pool.status, "open")
        self.assertIsNone(self.pool.seats["right"])

    def test_forfeit_and_rematch(self):
        a, b, c = self._join("alice"), self._join("bob"), self._join("carol")
        self._send(a, op="sit", seat="left")
        self._send(b, op="sit", seat="right")
        self._send(a, op="leave")
        self.assertEqual(self.pool.status, "over")
        self.assertEqual(self.pool.game["winner"], "right")
        # 新人入座空位即开新局
        self._send(c, op="sit", seat="left")
        self.assertEqual(self.pool.status, "playing")
        self.assertEqual(self.pool.seats["left"].username, "carol")
        # 结束后双方都申请才重开，输的一方开球
        game = self.pool.game
        shooter = c if game["turn"] == "left" else b
        self._send(shooter, op="shot", shot=_shot(), game=_next_game(game, phase="over", winner="left"))
        self._send(c, op="rematch")
        self.assertEqual(self.pool.status, "over")
        self.assertEqual(self.pool.rematch, {"left"})
        self._send(b, op="rematch")
        self.assertEqual(self.pool.status, "playing")
        self.assertEqual(self.pool.game["breaker"], "right")
        # 对局中不能换座
        self._send(c, op="sit", seat="right")
        self.assertEqual(self.pool.seats["left"].username, "carol")

    async def test_offline_releases_seat(self):
        a, b = self._join("alice"), self._join("bob")
        self._send(a, op="sit", seat="left")
        self._send(b, op="sit", seat="right")
        self.hub._detach(a)
        member = self.hub.members["alice"]
        member.leave_task.cancel()
        # 直接执行下线流程（不等宽限期）
        lobby_presence.LEAVE_GRACE_SECONDS, saved = 0, lobby_presence.LEAVE_GRACE_SECONDS
        try:
            await self.hub._leave_later(member)
        finally:
            lobby_presence.LEAVE_GRACE_SECONDS = saved
        self.assertIsNone(self.pool.seats["left"])
        self.assertEqual(self.pool.game["winner"], "right")
        self.assertNotIn(a, self.pool.watchers)

    def test_rename_updates_seat(self):
        a = self._join("alice")
        self._send(a, op="sit", seat="left")
        self.hub.update_profile("alice", {"name": "爱丽丝", "avatar": None})
        self.assertEqual(self.pool.seats["left"].name, "爱丽丝")


if __name__ == "__main__":
    unittest.main()
