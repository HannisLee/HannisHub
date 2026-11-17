"""管理员跨页面工位显示：临时数据库、连接优先级及普通账号边界。"""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from chatworld import lobby_presence, lobby_desks


class AdminPresenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, HANNISHUB_DB_PATH=self.tmp.name + "/test.db")
        self.env.start()
        self.hub = lobby_presence.LobbyPresence()

    async def asyncTearDown(self):
        for member in self.hub.members.values():
            if member.leave_task:
                member.leave_task.cancel()
        await asyncio.sleep(0)
        self.env.stop()
        self.tmp.cleanup()

    def join(self, owner="lihan", background=False, focused=True):
        conn = lobby_presence.Connection(websocket=None, username=owner, background=background, focused=focused)
        self.hub._attach(conn, {"name": owner, "avatar": None})
        return conn

    def move(self, conn, x=100):
        self.hub._handle_state(conn, {"room": "hall", "x": x, "y": 100, "dir": "up"})

    async def test_real_desk_and_no_automatic_claim(self):
        self.assertEqual(self.hub._admin_desk_state(), {"room": "room"})
        with patch.object(lobby_desks.lobby_profile, "get_profile", return_value={"name": "管理员"}):
            lobby_desks.claim("lihan", "desk-1")
            state = self.hub._admin_desk_state()
        layout = json.loads(Path("frontend/public/chat-lobby/club/layout.json").read_text())
        room = next(room for room in layout["rooms"] if room.get("desks"))
        seat = room["desks"][0]["seat"]
        self.assertEqual(state, {"room": room["id"], "x": room["x"] + seat["x"], "y": room["y"] + seat["y"], "dir": seat["dir"], "pose": "sit", "moving": False})

    async def test_foreground_lobby_and_background_desk(self):
        desk = self.join(background=True, focused=True)
        desk.state = {"room": "hall", "x": 68, "y": 988, "dir": "up", "pose": "sit", "moving": False}
        self.hub._select_admin(self.hub.members["lihan"], desk)
        lobby = self.join()
        self.move(lobby, 200)
        self.assertIs(self.hub.members["lihan"].primary, lobby)
        self.hub._handle_activity(lobby, {"active": False})
        self.assertIs(self.hub.members["lihan"].primary, desk)
        # 后台大厅继续上报移动，也不能夺走工位显示。
        self.move(lobby, 300)
        self.assertIs(self.hub.members["lihan"].primary, desk)
        self.hub._handle_activity(lobby, {"active": True})
        self.assertIs(self.hub.members["lihan"].primary, lobby)
        # 大厅连接退出后立即切回工位，账号角色编号不变。
        identity = self.hub.members["lihan"].id
        self.hub._detach(lobby)
        self.assertIs(self.hub.members["lihan"].primary, desk)
        self.assertEqual(self.hub.members["lihan"].id, identity)

    async def test_multiple_background_tabs_and_offline(self):
        a, b = self.join(background=True), self.join(background=True)
        for conn in [a, b]:
            conn.state = {"room": "hall", "x": 68, "y": 988, "dir": "up", "pose": "sit", "moving": False}
        member = self.hub.members["lihan"]
        self.hub._select_admin(member)
        self.hub._detach(a)
        self.assertIs(member.primary, b)
        self.assertIsNone(member.leave_task)
        with patch.object(lobby_presence, "LEAVE_GRACE_SECONDS", 0):
            self.hub._detach(b)
            await asyncio.sleep(0.01)
        self.assertNotIn("lihan", self.hub.members)

    async def test_regular_account_keeps_existing_selection(self):
        a, b = self.join("guest"), self.join("guest")
        self.move(a)
        self.move(b, 200)
        self.assertIs(self.hub.members["guest"].primary, b)
        self.hub._handle_activity(a, {"active": True})
        self.assertIs(self.hub.members["guest"].primary, b)
        self.move(a, 300)
        self.assertIs(self.hub.members["guest"].primary, a)

    async def test_regular_account_cannot_use_background_socket(self):
        class Socket:
            query_params = {"background": "1"}
            async def close(self, code):
                self.code = code
        socket = Socket()
        await self.hub.serve(socket, "guest")
        self.assertEqual(socket.code, lobby_presence.CLOSE_FORBIDDEN)
        self.assertFalse(self.hub.connections)


if __name__ == "__main__":
    unittest.main()
