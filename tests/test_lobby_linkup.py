"""使用临时数据库验证大厅街机连连看排行榜：只保留最高分、每日挑战日期校验、分数上限、限流与名字显示。"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from unittest.mock import patch

from fastapi import HTTPException

from chatworld import lobby_linkup as ll


class LobbyLinkupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, HANNISHUB_DB_PATH=self.tmp.name + "/test.db")
        self.env.start()
        self.profile = patch.object(ll.lobby_profile, "get_profile", side_effect=lambda name: {"name": f"昵称{name}"})
        self.profile.start()
        self.clock = patch.object(ll.time, "time", side_effect=self._now)
        self.now = 1000.0
        self.clock.start()
        ll._last_submit.clear()

    def tearDown(self):
        self.clock.stop(); self.profile.stop(); self.env.stop(); self.tmp.cleanup()

    def _now(self):
        return self.now

    def submit(self, user, **payload):
        self.now += 5
        return ll.submit(user, payload)

    def test_keeps_best_score_and_counts_plays(self):
        first = self.submit("alice", mode="campaign", score=1200, level=3)
        self.assertTrue(first["record"])
        self.assertEqual(first["rank"], 1)
        lower = self.submit("alice", mode="campaign", score=800, level=2)
        self.assertFalse(lower["record"])
        self.assertEqual(lower["previous"], 1200)
        higher = self.submit("alice", mode="campaign", score=2500, level=5, cleared=True)
        self.assertTrue(higher["record"])
        self.submit("bob", mode="campaign", score=3000, level=6)
        state = ll.board("alice")
        self.assertEqual([row["name"] for row in state["campaign"]], ["昵称bob", "昵称alice"])
        self.assertEqual(state["campaign"][1]["score"], 2500)
        self.assertEqual(state["campaign"][1]["plays"], 3)
        self.assertTrue(state["campaign"][1]["mine"])
        self.assertNotIn("owner", state["campaign"][0])
        self.assertEqual(state["mine"]["campaign"]["rank"], 2)
        self.assertIsNone(state["mine"]["daily"])

    def test_daily_day_validation(self):
        today = date.today()
        self.submit("alice", mode="daily", score=900, day=today.isoformat(), cleared=True)
        self.submit("alice", mode="daily", score=500, day=(today - timedelta(days=1)).isoformat())
        with self.assertRaises(HTTPException) as ctx:
            self.submit("alice", mode="daily", score=500, day=(today - timedelta(days=2)).isoformat())
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            self.submit("alice", mode="daily", score=500, day="bogus")
        state = ll.board("alice")
        self.assertEqual(state["day"], today.isoformat())
        self.assertEqual(len(state["daily"]), 1)
        self.assertEqual(state["daily"][0]["score"], 900)
        self.assertTrue(state["daily"][0]["cleared"])

    def test_validation_and_rate_limit(self):
        for bad in ({"mode": "casual", "score": 1}, {"mode": "campaign", "score": -1}, {"mode": "campaign", "score": "9"},
                    {"mode": "campaign", "score": True}, {"mode": "campaign", "score": ll.MAX_PER_LEVEL + 1, "level": 1},
                    {"mode": "campaign", "score": 10, "level": 0}):
            with self.assertRaises(HTTPException, msg=bad):
                self.submit("alice", **bad)
        self.submit("alice", mode="campaign", score=ll.MAX_PER_LEVEL * 2, level=2)
        with self.assertRaises(HTTPException) as ctx:
            ll.submit("alice", {"mode": "campaign", "score": 10, "level": 1})
        self.assertEqual(ctx.exception.status_code, 429)

    def test_purge_user(self):
        self.submit("alice", mode="campaign", score=100, level=1)
        ll.purge_user("alice")
        self.assertEqual(ll.board("alice")["campaign"], [])


if __name__ == "__main__":
    unittest.main()
