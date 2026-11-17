"""验证 HTML 预览目录边界、相对资源与静态沙箱策略。"""

import asyncio
import stat
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

import app as hub
from server import file_manager, remote_files


class HtmlPreviewTests(unittest.TestCase):
    def assert_static_sandbox(self, response):
        policy = response.headers["Content-Security-Policy"]
        self.assertIn("sandbox allow-same-origin", policy)
        self.assertIn("script-src 'none'", policy)
        self.assertNotIn("allow-scripts", policy)
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

    def test_local_html_and_relative_resource(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "报告").mkdir()
            (root / "报告" / "页面.htm").write_text("<h1>报告</h1>")
            (root / "报告" / "theme.css").write_text("h1 { color: red; }")
            with patch.object(file_manager, "configured_roots", return_value=[directory]):
                response = asyncio.run(hub.file_manager_preview(0, "报告/页面.htm"))
                self.assertEqual(response.media_type, "text/html")
                self.assertEqual(response.path, root / "报告" / "页面.htm")
                self.assert_static_sandbox(response)
                style = asyncio.run(hub.file_manager_preview(0, "报告/theme.css"))
                self.assertEqual(style.media_type, "text/css")
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(hub.file_manager_preview(0, "../outside.html"))
                self.assertEqual(caught.exception.status_code, 422)
                with self.assertRaises(HTTPException):
                    asyncio.run(hub.file_manager_preview(-1, "报告/页面.htm"))

    def test_remote_html_and_resource(self):
        class SFTP:
            def stat(self, path):
                return SimpleNamespace(st_mode=stat.S_IFREG, st_size=6)

        @contextmanager
        def connection(connection_id):
            self.assertEqual(connection_id, "test")
            yield SFTP(), "/home/test"

        request = Request({"type": "http", "headers": []})
        with patch.object(remote_files, "remote_sftp", connection), patch.object(remote_files, "_stream_file", return_value=iter([b"report"])):
            response = asyncio.run(hub.file_manager_remote_preview(request, "test", "报告/页面.html"))
            self.assertEqual(response.media_type, "text/html")
            self.assert_static_sandbox(response)
            self.assertIn("inline", response.headers["Content-Disposition"])
            with self.assertRaises(HTTPException):
                asyncio.run(hub.file_manager_remote_preview(request, "test", "../outside.html"))


if __name__ == "__main__":
    unittest.main()
