"""使用临时数据库验证功能改进建议板的提交、限流、状态与删除权限。"""
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from chatworld import feature_requests as fr
from core.auth import ADMIN_USERNAME


class FeatureRequestsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, HANNISHUB_DB_PATH=self.tmp.name + "/test.db")
        self.env.start()
        self.profile = patch.object(fr.lobby_profile, "get_profile", side_effect=lambda name: {"name": f"昵称{name}"})
        self.profile.start()

    def tearDown(self):
        self.profile.stop(); self.env.stop(); self.tmp.cleanup()

    def test_post_list_and_clean(self):
        item = fr.post_request("alice", {"text": "  加个暗色\x00模式\n\n\n\n支持快捷键 "})
        self.assertEqual(item["text"], "加个暗色模式\n\n支持快捷键")
        self.assertEqual(item["status"], "open")
        self.assertEqual(item["name"], "昵称alice")
        state = fr.list_requests("bob")
        self.assertFalse(state["items"][0]["mine"])
        self.assertFalse(state["can_moderate"])
        self.assertNotIn("owner", state["items"][0])
        with self.assertRaises(HTTPException):
            fr.post_request("bob", {"text": "   "})
        self.assertEqual(len(fr.post_request("bob", {"text": "x" * 5000})["text"]), fr.MAX_TEXT)

    def test_rate_limit(self):
        fr.post_request("alice", {"text": "一"})
        with self.assertRaises(HTTPException) as ctx:
            fr.post_request("alice", {"text": "二"})
        self.assertEqual(ctx.exception.status_code, 429)

    def test_status_and_delete_permissions(self):
        item = fr.post_request("alice", {"text": "建议"})
        with self.assertRaises(HTTPException) as ctx:
            fr.set_status("alice", item["id"], {"status": "done"})
        self.assertEqual(ctx.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            fr.set_status(ADMIN_USERNAME, item["id"], {"status": "bogus"})
        self.assertEqual(fr.set_status(ADMIN_USERNAME, item["id"], {"status": "accepted"})["status"], "accepted")
        with self.assertRaises(HTTPException):
            fr.delete_request("bob", item["id"])
        fr.delete_request("alice", item["id"])
        other = fr.post_request("bob", {"text": "另一条"})
        fr.delete_request(ADMIN_USERNAME, other["id"])
        self.assertEqual(fr.list_requests("alice")["items"], [])

    def test_purge_user(self):
        fr.post_request("alice", {"text": "a"})
        fr.post_request("bob", {"text": "b"})
        fr.purge_user("alice")
        self.assertEqual([i["text"] for i in fr.list_requests("bob")["items"]], ["b"])


if __name__ == "__main__":
    unittest.main()
