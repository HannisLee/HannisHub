"""终端命令组：临时 SQLite 中的字段校验、按账号隔离、修改删除与数量上限。"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from core import database
from server import terminal_commands


class TerminalCommandTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patcher = patch.dict("os.environ", {"HANNISHUB_DB_PATH": str(Path(directory.name) / "test.db")})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_schema_and_crud(self):
        group = terminal_commands.create_group("lihan", {"name": " 构建 前端 ", "commands": ["npm run lint", "npm run build"]})
        self.assertRegex(group["id"], r"^tc_[0-9a-f]{16}$")
        self.assertEqual(group["name"], "构建 前端")
        self.assertEqual(group["commands"], ["npm run lint", "npm run build"])
        with database.connect() as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], len(database._MIGRATIONS))

        updated = terminal_commands.update_group("lihan", group["id"], {"name": "前端检查", "commands": ["npm run typecheck"]})
        self.assertEqual((updated["name"], updated["commands"]), ("前端检查", ["npm run typecheck"]))
        self.assertEqual(terminal_commands.get_group("lihan", group["id"])["name"], "前端检查")
        terminal_commands.delete_group("lihan", group["id"])
        self.assertEqual(terminal_commands.list_groups("lihan"), [])

    def test_owner_isolation(self):
        group = terminal_commands.create_group("alice", {"name": "Alice", "commands": ["pwd"]})
        terminal_commands.create_group("bob", {"name": "Bob", "commands": ["whoami"]})
        for action in (
            lambda: terminal_commands.get_group("bob", group["id"]),
            lambda: terminal_commands.update_group("bob", group["id"], {"name": "偷改"}),
            lambda: terminal_commands.delete_group("bob", group["id"]),
        ):
            with self.assertRaises(HTTPException) as ctx:
                action()
            self.assertEqual(ctx.exception.status_code, 404)
        terminal_commands.purge_user("alice")
        self.assertEqual([item["name"] for item in terminal_commands.list_groups("bob")], ["Bob"])

    def test_validation_and_caps(self):
        for payload in (
            {"name": " ", "commands": ["pwd"]},
            {"name": "有效", "commands": []},
            {"name": "有效", "commands": [" "]},
            {"name": "有效", "commands": [123]},
            {"name": "有效", "commands": ["x" * (terminal_commands.MAX_COMMAND_CHARS + 1)]},
        ):
            with self.subTest(payload=payload), self.assertRaises(HTTPException) as ctx:
                terminal_commands.create_group("alice", payload)
            self.assertEqual(ctx.exception.status_code, 400)

        with patch.object(terminal_commands, "MAX_GROUPS", 2):
            for index in range(2):
                terminal_commands.create_group("alice", {"name": f"命令{index}", "commands": ["pwd"]})
            with self.assertRaises(HTTPException) as ctx:
                terminal_commands.create_group("alice", {"name": "第三组", "commands": ["pwd"]})
            self.assertEqual(ctx.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
