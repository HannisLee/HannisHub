"""验证文档下载的本机与远端目录打包内容。"""

import asyncio
import io
import tempfile
import unittest
import zipfile
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import stat

from fastapi import HTTPException
from server import file_manager, remote_files


async def response_bytes(response):
    return b"".join([chunk async for chunk in response.body_iterator])


class DocumentDownloadTests(unittest.TestCase):
    def test_local_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "中文资料"
            (folder / "空目录").mkdir(parents=True)
            (folder / "内容.txt").write_text("测试内容")
            (folder / "循环").symlink_to(folder, target_is_directory=True)
            with patch.object(file_manager, "configured_roots", return_value=[directory]):
                response = file_manager.download_response(0, folder.name)
                self.assertIn(".zip", response.headers["content-disposition"])
                with zipfile.ZipFile(io.BytesIO(asyncio.run(response_bytes(response)))) as bundle:
                    self.assertEqual(set(bundle.namelist()), {"中文资料/", "中文资料/空目录/", "中文资料/内容.txt"})
                    self.assertEqual(bundle.read("中文资料/内容.txt").decode(), "测试内容")
                with self.assertRaises(HTTPException):
                    file_manager.download_response(0, "../outside")
                self.assertEqual(file_manager.download_response(0, "中文资料/内容.txt").filename, "内容.txt")

    def test_remote_archive(self):
        class SFTP:
            def stat(self, path):
                return SimpleNamespace(st_mode=stat.S_IFDIR)

            def listdir_attr(self, path):
                return [] if path.endswith("/空目录") else [
                    SimpleNamespace(filename="空目录", st_mode=stat.S_IFDIR),
                    SimpleNamespace(filename="文档.txt", st_mode=stat.S_IFREG),
                    SimpleNamespace(filename="循环", st_mode=stat.S_IFLNK),
                ]

            def open(self, path, mode):
                return io.BytesIO(b"remote content")

        @contextmanager
        def connection(connection_id):
            yield SFTP(), "/home/test"

        with patch.object(remote_files, "remote_sftp", connection):
            response = remote_files.file_response("test", "资料", None, inline=False)
            with zipfile.ZipFile(io.BytesIO(asyncio.run(response_bytes(response)))) as bundle:
                self.assertEqual(set(bundle.namelist()), {"资料/", "资料/空目录/", "资料/文档.txt"})
                self.assertEqual(bundle.read("资料/文档.txt"), b"remote content")


if __name__ == "__main__":
    unittest.main()
