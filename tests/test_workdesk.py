"""工位待办与聊天大厅工位认领：按账号隔离、字段校验、排序与清理、认领冲突，以及多人同步的坐姿与表情。
全部使用临时库与临时资料文件，不读写线上 data/。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from chatworld import lobby_desks, lobby_presence, lobby_profile, todos
from core import database


class _TempData(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        root = Path(self._dir.name)
        for patcher in (
            patch.dict("os.environ", {"HANNISHUB_DB_PATH": str(root / "test.db")}),
            patch.object(lobby_profile, "PROFILES_PATH", root / "profiles.json"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)


class TodoTest(_TempData):
    def test_schema_version(self):
        todos.list_todos("alice")
        with database.connect() as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], len(database._MIGRATIONS))

    def test_create_and_isolation(self):
        a = todos.create_todo("alice", {"title": "  写周报\n", "priority": 3, "due_date": "2026-11-20", "list": "工作"})
        self.assertEqual(a["title"], "写周报")
        self.assertEqual((a["priority"], a["due_date"], a["list"], a["done"]), (3, "2026-11-20", "工作", False))
        todos.create_todo("bob", {"title": "bob 的事"})
        self.assertEqual([t["title"] for t in todos.list_todos("alice")], ["写周报"])
        self.assertEqual([t["title"] for t in todos.list_todos("bob")], ["bob 的事"])
        # 别人的待办：改、删都按不存在处理
        with self.assertRaises(HTTPException) as ctx:
            todos.update_todo("bob", a["id"], {"done": True})
        self.assertEqual(ctx.exception.status_code, 404)
        with self.assertRaises(HTTPException):
            todos.delete_todo("bob", a["id"])
        self.assertFalse(todos.list_todos("alice")[0]["done"])

    def test_validation(self):
        for payload in (
            {"title": "   "},
            {"title": "x", "priority": 5},
            {"title": "x", "priority": True},
            {"title": "x", "due_date": "2026-13-01"},
            {"title": "x", "done": "yes"},
            {"title": "x", "subtasks": [{"id": "bad id!", "title": "a"}]},
            {"title": "x", "subtasks": [{"id": "s1", "title": ""}]},
            {"title": "x", "subtasks": [{"id": f"s{i}", "title": "a"} for i in range(todos.MAX_SUBTASKS + 1)]},
            {"title": "x", "sort": float("nan")},
        ):
            with self.subTest(payload=payload), self.assertRaises(HTTPException) as ctx:
                todos.create_todo("alice", payload)
            self.assertEqual(ctx.exception.status_code, 400)
        long = todos.create_todo("alice", {"title": "a" * 500, "note": "第一行\n第二行\x00", "list": "清" * 40})
        self.assertEqual(len(long["title"]), todos.MAX_TITLE)
        self.assertEqual(long["note"], "第一行\n第二行")
        self.assertEqual(len(long["list"]), todos.MAX_LIST)

    def test_update_done_subtasks(self):
        t = todos.create_todo("alice", {"title": "发版"})
        done = todos.update_todo("alice", t["id"], {"done": True, "subtasks": [{"id": "s1", "title": "打标签", "done": True}]})
        self.assertTrue(done["done"])
        self.assertIsNotNone(done["done_at"])
        self.assertEqual(done["subtasks"], [{"id": "s1", "title": "打标签", "done": True}])
        undone = todos.update_todo("alice", t["id"], {"done": False, "my_day": "2026-11-14"})
        self.assertFalse(undone["done"])
        self.assertIsNone(undone["done_at"])
        self.assertEqual(undone["my_day"], "2026-11-14")
        with self.assertRaises(HTTPException):
            todos.update_todo("alice", "../etc", {"done": True})

    def test_reorder_clear_purge(self):
        ids = [todos.create_todo("alice", {"title": f"任务{i}", "list": "A" if i < 2 else "B"})["id"] for i in range(4)]
        bob = todos.create_todo("bob", {"title": "bob"})["id"]
        # 交换第 0、1 条；混入别人的编号被忽略
        result = todos.reorder("alice", [ids[1], ids[0], bob])
        self.assertEqual([t["id"] for t in result], [ids[1], ids[0], ids[2], ids[3]])
        with self.assertRaises(HTTPException):
            todos.reorder("alice", ["not-an-id"])
        for i in (0, 2, 3):
            todos.update_todo("alice", ids[i], {"done": True})
        self.assertEqual(todos.clear_completed("alice", "B"), 2)
        self.assertEqual(todos.clear_completed("alice"), 1)
        self.assertEqual([t["id"] for t in todos.list_todos("alice")], [ids[1]])
        self.assertEqual(len(todos.list_todos("bob")), 1)
        todos.purge_user("alice")
        self.assertEqual(todos.list_todos("alice"), [])
        self.assertEqual(len(todos.list_todos("bob")), 1)

    def test_limit(self):
        with patch.object(todos, "MAX_TODOS", 2):
            todos.create_todo("alice", {"title": "1"})
            todos.create_todo("alice", {"title": "2"})
            with self.assertRaises(HTTPException):
                todos.create_todo("alice", {"title": "3"})
            todos.create_todo("bob", {"title": "别人不受影响"})


class DeskTest(_TempData):
    def test_claim_switch_release(self):
        lobby_profile.save_profile("alice", {"name": "爱丽丝", "avatar": None})
        state = lobby_desks.claim("alice", "desk-2")
        self.assertEqual(state, {"desks": {"desk-2": {"name": "爱丽丝", "mine": True}}, "mine": "desk-2"})
        # 别人看到的是显示名字，不是登录用户名
        self.assertEqual(lobby_desks.desk_state("bob"), {"desks": {"desk-2": {"name": "爱丽丝", "mine": False}}, "mine": None})
        with self.assertRaises(HTTPException) as ctx:
            lobby_desks.claim("bob", "desk-2")
        self.assertEqual(ctx.exception.status_code, 409)
        # 换工位：原来的自动退还
        state = lobby_desks.claim("alice", "desk-5")
        self.assertEqual(list(state["desks"]), ["desk-5"])
        self.assertEqual(lobby_desks.claim("bob", "desk-2")["mine"], "desk-2")
        self.assertEqual(lobby_desks.release("alice")["mine"], None)
        self.assertEqual(list(lobby_desks.desk_state("alice")["desks"]), ["desk-2"])
        lobby_desks.purge_user("bob")
        self.assertEqual(lobby_desks.desk_state("alice")["desks"], {})

    def test_invalid_desk(self):
        for desk in ("desk-0", f"desk-{lobby_desks.DESK_COUNT + 1}", "../x", 3, None):
            with self.subTest(desk=desk), self.assertRaises(HTTPException) as ctx:
                lobby_desks.claim("alice", desk)
            self.assertEqual(ctx.exception.status_code, 400)


class _FakeSocket:
    def __init__(self):
        self.sent = []


class PresenceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hub = lobby_presence.LobbyPresence()

    def _join(self, username):
        conn = lobby_presence.Connection(websocket=_FakeSocket(), username=username)
        self.hub._attach(conn, {"name": username, "avatar": None})
        return conn

    @staticmethod
    def _drain(conn):
        items = []
        while not conn.queue.empty():
            items.append(json.loads(conn.queue.get_nowait()))
        return items

    async def test_pose_and_emote(self):
        a, b = self._join("alice"), self._join("bob")
        self.hub._handle_state(a, {"room": "hall", "x": 10, "y": 20, "dir": "up", "moving": False, "pose": "sit"})
        msgs = self._drain(b)
        self.assertEqual(msgs[0]["type"], "player")
        self.assertEqual(msgs[0]["player"]["pose"], "sit")
        # 未知姿势按站立处理
        self.hub._handle_state(a, {"room": "hall", "x": 10, "y": 20, "dir": "up", "moving": False, "pose": "fly"})
        self.assertEqual(self._drain(b)[0]["pose"], "")
        self.hub._handle_emote(a, {"key": "coffee"})
        self.hub._handle_emote(a, {"key": "coffee"})  # 限速：0.5 秒内第二次丢弃
        self.hub._handle_emote(a, {"key": "<script>"})
        msgs = self._drain(b)
        self.assertEqual(msgs, [{"type": "emote", "id": self.hub.members["alice"].id, "key": "coffee"}])
        self.assertEqual(self._drain(a), [])

    async def test_emote_not_from_private_room(self):
        a, b = self._join("alice"), self._join("bob")
        self.hub._handle_state(a, {"room": "room"})
        self.hub._handle_emote(a, {"key": "wave"})
        self.assertEqual(self._drain(b), [])

    async def test_notify_desks_reaches_everyone(self):
        a, b = self._join("alice"), self._join("bob")
        self.hub.notify_desks()
        self.assertEqual(self._drain(a), [{"type": "desks"}])
        self.assertEqual(self._drain(b), [{"type": "desks"}])
        await asyncio.sleep(0)


if __name__ == "__main__":
    unittest.main()
