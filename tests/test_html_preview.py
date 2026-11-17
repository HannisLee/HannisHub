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
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

import app as hub
from server import file_manager, remote_files
from server import html_preview
from core.auth import AuthMiddleware


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


class InteractiveHtmlPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        (root / "汇报" / "assets").mkdir(parents=True)
        (root / "汇报" / "slides.html").write_text('<script>document.body.dataset.page="1"</script>')
        (root / "汇报" / "assets" / "theme.css").write_text("body { color: red; }")
        (root / "secret.txt").write_text("不应被预览票据读取")
        for mocked in [patch.object(file_manager, "configured_roots", return_value=[str(root)]),
                       patch.object(html_preview, "session_version", return_value=1)]:
            mocked.start()
            self.addCleanup(mocked.stop)
        with html_preview._lock:
            html_preview._tickets.clear()
        self.url = html_preview.issue_ticket("lihan", 0, "local", "汇报/slides.html")["url"]
        application = FastAPI()
        application.add_middleware(AuthMiddleware)
        application.add_api_route("/api/file-manager/html-preview/{token}/{path:path}", hub.file_manager_html_preview_resource)

        @application.get("/api/private")
        async def private():
            return {"secret": True}

        self.client = TestClient(application)

    def test_cookie_free_scripts_and_scoped_assets(self):
        with patch("core.auth.current_username", return_value=None):
            response = self.client.get(self.url)
            self.assertEqual(response.status_code, 200)
            self.assertIn("<script>", response.text)
            self.assertIn("hannishub-html-escape", response.text)
            self.assertIn("sandbox allow-scripts", response.headers["Content-Security-Policy"])
            self.assertNotIn("allow-same-origin", response.headers["Content-Security-Policy"])
            self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
            self.assertEqual(self.client.get(self.url.replace("slides.html", "assets/theme.css")).status_code, 200)
            self.assertEqual(self.client.get("/api/private").status_code, 401)
            self.assertEqual(self.client.get(self.url.replace("slides.html", "%2e%2e/secret.txt")).status_code, 401)
            self.assertEqual(self.client.get(self.url.replace("slides.html", "settings.json")).status_code, 401)
            self.assertEqual(self.client.get(self.url.replace("slides.html", ".ssh/id_ed25519")).status_code, 401)
            self.assertEqual(self.client.post(self.url).status_code, 401)

    def test_invalid_expired_and_revoked_tickets(self):
        self.assertEqual(self.client.get(self.url.replace("/html-preview/", "/html-preview/invalid")).status_code, 401)
        with patch.object(html_preview.time, "time", return_value=10**12):
            self.assertEqual(self.client.get(self.url).status_code, 401)
        with patch.object(html_preview, "session_version", return_value=2):
            self.assertEqual(self.client.get(self.url).status_code, 401)
        with self.assertRaises(HTTPException):
            html_preview.issue_ticket("guest", 0, "local", "汇报/slides.html")
        with self.assertRaises(HTTPException):
            html_preview.issue_ticket("lihan", 0, "local", "secret.txt")

    def test_remote_interactive_html(self):
        @contextmanager
        def connection(connection_id):
            self.assertEqual(connection_id, "remote-test")
            yield SimpleNamespace(stat=lambda path: SimpleNamespace(st_mode=stat.S_IFREG, st_size=19)), "/home/test"

        with patch.object(remote_files, "remote_sftp", connection), patch.object(remote_files, "_stream_file", return_value=iter([b"<h1>test</h1>"])):
            url = html_preview.issue_ticket("lihan", 0, "remote-test", "reports/slides.html")["url"]
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertIn("<h1>test</h1>", response.text)
            self.assertIn("hannishub-html-escape", response.text)


if __name__ == "__main__":
    unittest.main()
