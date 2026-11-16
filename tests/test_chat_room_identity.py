"""聊天室资料绑定账号：名字与头像以聊天大厅「我的房间」为准（临时数据文件，不触碰线上数据）。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from chatworld import chat_room, lobby_profile


class ChatRoomIdentityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patchers = [
            patch.object(lobby_profile, "PROFILES_PATH", root / "profiles.json"),
            patch.object(chat_room, "CHAT_ROOM_PATH", root / "chat_room.json"),
            patch.object(chat_room, "READS_PATH", root / "reads.json"),
            patch.object(chat_room, "_reads", {}),
        ]
        for item in self.patchers:
            item.start()

    def tearDown(self):
        for item in reversed(self.patchers):
            item.stop()
        self.tmp.cleanup()

    def test_linked_profile_follows_lobby(self):
        lobby_profile.save_profile("alice", {"name": "小明", "avatar": None, "photo": "🐱"})
        saved = chat_room.save_profile({"client_id": "client-alice", "nickname": "随便", "avatar": "🐶"}, "alice")
        self.assertEqual((saved["nickname"], saved["avatar"], saved["linked"]), ("小明", "🐱", True))
        guest = chat_room.save_profile({"client_id": "client-guest", "nickname": "访客", "avatar": ""})
        self.assertFalse(guest["linked"])

        first = chat_room.list_messages(client_id="client-alice")
        self.assertNotIn("username", first["profiles"]["client-alice"])
        message = chat_room.post_message({"client_id": "client-alice", "content": "hi"})
        self.assertEqual(message["nickname"], "小明")

        # 在「我的房间」改名换头像后，资料版本换代，所有客户端看到新名字与头像
        lobby_profile.save_profile("alice", {"name": "大明", "avatar": None, "photo": ""})
        chat_room.bump_profiles_version()
        later = chat_room.list_messages(client_id="client-alice", profiles_version=first["profiles_version"])
        self.assertGreater(later["profiles_version"], first["profiles_version"])
        self.assertEqual(later["profiles"]["client-alice"]["nickname"], "大明")
        self.assertEqual(later["profiles"]["client-alice"]["avatar"], "")
        self.assertEqual(later["profiles"]["client-guest"]["nickname"], "访客")


if __name__ == "__main__":
    unittest.main()
