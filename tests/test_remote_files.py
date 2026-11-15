"""测试服务器文件远程浏览与常用目录管理逻辑。"""

import unittest
from fastapi import HTTPException
from server.remote_files import (
    normalize_common_directories,
    list_file_connections,
    _extension,
    _join,
    _parse_range,
    MAX_COMMON_DIRECTORIES,
)


class RemoteFilesTestCase(unittest.TestCase):
    def test_normalize_common_directories(self):
        # 接受 ~, ~/path, path, 过滤空和重复
        dirs = normalize_common_directories(["~", "~/reproduce", "reproduce/sub", "reproduce", ""])
        self.assertEqual(dirs, ["", "reproduce", "reproduce/sub"])

        # 绝对路径拒绝
        with self.assertRaises(HTTPException) as ctx:
            normalize_common_directories(["/etc/passwd"])
        self.assertEqual(ctx.exception.status_code, 422)

        # 越界 .. 拒绝
        with self.assertRaises(HTTPException) as ctx:
            normalize_common_directories(["~/../sensitive"])
        self.assertEqual(ctx.exception.status_code, 422)

        # 超出最大限制拒绝
        with self.assertRaises(HTTPException) as ctx:
            normalize_common_directories([f"dir_{i}" for i in range(MAX_COMMON_DIRECTORIES + 1)])
        self.assertEqual(ctx.exception.status_code, 422)

    def test_list_file_connections(self):
        conns = list_file_connections()
        self.assertTrue(len(conns) >= 1)
        self.assertEqual(conns[0]["id"], "local")
        self.assertEqual(conns[0]["name"], "本机")
        self.assertEqual(conns[0]["type"], "local")

    def test_path_helpers(self):
        self.assertEqual(_extension("model.tar.gz"), "gz")
        self.assertEqual(_extension("README.MD"), "md")
        self.assertEqual(_extension("noext"), "")

        self.assertEqual(_join("/home/han.li", ""), "/home/han.li")
        self.assertEqual(_join("/home/han.li", "reproduce"), "/home/han.li/reproduce")
        self.assertEqual(_join("/", "reproduce"), "/reproduce")

    def test_parse_range(self):
        self.assertIsNone(_parse_range(None, 100))
        self.assertEqual(_parse_range("bytes=0-49", 100), (0, 49))
        self.assertEqual(_parse_range("bytes=50-", 100), (50, 99))
        self.assertEqual(_parse_range("bytes=-20", 100), (80, 99))

        with self.assertRaises(HTTPException):
            _parse_range("bytes=200-300", 100)


if __name__ == "__main__":
    unittest.main()
