"""聊天大厅个人资料：名字与形象的校验、默认值和持久化（使用临时数据文件，不触碰线上数据）。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from chatworld import lobby_profile


class LobbyProfileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patcher = patch.object(lobby_profile, "PROFILES_PATH", Path(self.tmp.name) / "profiles.json")
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def test_default_profile_uses_username(self):
        profile = lobby_profile.get_profile("alice")
        self.assertEqual(profile["name"], "alice")
        self.assertIsNone(profile["avatar"])

    def test_save_and_read_back(self):
        avatar = {"body": "Body_03", "eyes": "Eyes_02", "outfit": "Outfit_05_01", "hair": "", "accessory": "Accessory_15_Glasses_01"}
        saved = lobby_profile.save_profile("alice", {"name": "  小\t明\x00 ", "avatar": avatar})
        self.assertEqual(saved["name"], "小 明")
        self.assertEqual(lobby_profile.get_profile("alice")["avatar"], avatar)
        self.assertEqual(lobby_profile.get_profile("bob")["name"], "bob")

    def test_name_is_truncated_and_required(self):
        saved = lobby_profile.save_profile("alice", {"name": "x" * 40, "avatar": None})
        self.assertEqual(len(saved["name"]), lobby_profile.MAX_NAME_CHARS)
        with self.assertRaises(HTTPException):
            lobby_profile.save_profile("alice", {"name": "   ", "avatar": None})

    def test_avatar_validation(self):
        bad = [
            "Body_01",
            {"body": "", "eyes": "Eyes_01", "outfit": "Outfit_01_01"},
            {"body": "../etc", "eyes": "Eyes_01", "outfit": "Outfit_01_01"},
            {"body": "Body_01", "eyes": "Eyes_01", "outfit": "Outfit_01_01", "hair": "<script>"},
        ]
        for avatar in bad:
            with self.assertRaises(HTTPException, msg=str(avatar)):
                lobby_profile.save_profile("alice", {"name": "a", "avatar": avatar})


if __name__ == "__main__":
    unittest.main()
