"""轻量 HTTP 正向代理模块单元测试（使用临时配置文件，不触碰线上配置与外网）。"""

import asyncio
import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core import auth, http_proxy


def _basic_header(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


class HttpProxyUnitTest(unittest.TestCase):
    def test_normalize_config_validation(self):
        cfg = http_proxy.normalize_config({
            "enabled": True,
            "host": "127.0.0.1",
            "port": 18088,
            "username": "alice",
            "password": "strongpassword123",
            "public_host": "frp.example.com",
            "public_port": 23456,
        })
        self.assertTrue(cfg["enabled"])
        self.assertEqual(cfg["port"], 18088)
        self.assertEqual(cfg["public_port"], 23456)

        with self.assertRaises(ValueError):
            http_proxy.normalize_config({"host": "192.168.1.2"})
        with self.assertRaises(ValueError):
            http_proxy.normalize_config({"port": 8081})
        with self.assertRaises(ValueError):
            http_proxy.normalize_config({"port": 18082})
        with self.assertRaises(ValueError):
            http_proxy.normalize_config({"password": "short"})
        with self.assertRaises(ValueError):
            http_proxy.normalize_config({"username": "bad:user"})

    def test_forbidden_target_blocks_loopback(self):
        self.assertTrue(http_proxy.is_forbidden_target("127.0.0.1"))
        self.assertTrue(http_proxy.is_forbidden_target("::1"))
        self.assertTrue(http_proxy.is_forbidden_target("localhost"))
        self.assertTrue(http_proxy.is_forbidden_target("sub.localhost"))
        self.assertTrue(http_proxy.is_forbidden_target("0.0.0.0"))
        self.assertFalse(http_proxy.is_forbidden_target("example.com"))
        self.assertFalse(http_proxy.is_forbidden_target("1.1.1.1"))


class HttpProxyAsyncTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._orig_settings = auth.SETTINGS_PATH
        auth.SETTINGS_PATH = Path(self._tmpdir.name) / "settings.json"
        self.service = http_proxy.HttpProxyService()

    async def asyncTearDown(self):
        await self.service.stop()
        auth.SETTINGS_PATH = self._orig_settings
        self._tmpdir.cleanup()

    async def _send_raw(self, port: int, payload: bytes) -> bytes:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        try:
            writer.write(payload)
            await writer.drain()
            return await asyncio.wait_for(reader.read(4096), timeout=5.0)
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_auth_required_and_loopback_blocked(self):
        # 绑定临时可用端口（通过先探测空闲端口）
        probe = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
        free_port = probe.sockets[0].getsockname()[1]
        probe.close()
        await probe.wait_closed()

        snap = await self.service.apply_config({
            "enabled": True,
            "host": "127.0.0.1",
            "port": free_port,
            "username": "tester",
            "password": "secret-password-99",
        })
        self.assertTrue(snap["running"])
        self.assertEqual(snap["bound_port"], free_port)

        # 未提供认证 -> 407
        resp_no_auth = await self._send_raw(
            free_port,
            b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
        )
        self.assertTrue(resp_no_auth.startswith(b"HTTP/1.1 407"))
        self.assertEqual(self.service.status_snapshot()["auth_failures"], 1)

        # 正确认证但目标为回环地址 -> 403
        auth_val = _basic_header("tester", "secret-password-99")
        resp_loopback = await self._send_raw(
            free_port,
            (
                "CONNECT 127.0.0.1:18082 HTTP/1.1\r\n"
                "Host: 127.0.0.1:18082\r\n"
                f"Proxy-Authorization: {auth_val}\r\n\r\n"
            ).encode("ascii"),
        )
        self.assertTrue(resp_loopback.startswith(b"HTTP/1.1 403"))

    async def test_connect_and_http_forwarding(self):
        # 启动一个本地目标 HTTP 回显服务
        async def handle_upstream(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
            try:
                data = await reader.read(4096)
                if data.startswith(b"PING"):
                    writer.write(b"PONG")
                else:
                    body = b"hello-from-upstream"
                    writer.write(
                        b"HTTP/1.1 200 OK\r\n"
                        b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n"
                        b"Connection: close\r\n\r\n" + body
                    )
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        upstream = await asyncio.start_server(handle_upstream, "127.0.0.1", 0)
        upstream_port = upstream.sockets[0].getsockname()[1]

        probe = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
        proxy_port = probe.sockets[0].getsockname()[1]
        probe.close()
        await probe.wait_closed()

        try:
            await self.service.apply_config({
                "enabled": True,
                "host": "127.0.0.1",
                "port": proxy_port,
                "username": "tester",
                "password": "secret-password-99",
            })
            auth_val = _basic_header("tester", "secret-password-99")

            # 在测试中临时放行回环目标，验证真实 TCP 转发与 CONNECT 隧道
            with patch.object(http_proxy, "is_forbidden_target", return_value=False):
                # 1. 测试普通 HTTP 正向代理
                resp = await self._send_raw(
                    proxy_port,
                    (
                        f"GET http://127.0.0.1:{upstream_port}/test HTTP/1.1\r\n"
                        f"Host: 127.0.0.1:{upstream_port}\r\n"
                        f"Proxy-Authorization: {auth_val}\r\n\r\n"
                    ).encode("ascii"),
                )
                self.assertIn(b"200 OK", resp)
                self.assertIn(b"hello-from-upstream", resp)

                # 2. 测试 CONNECT 隧道
                reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
                try:
                    writer.write(
                        (
                            f"CONNECT 127.0.0.1:{upstream_port} HTTP/1.1\r\n"
                            f"Host: 127.0.0.1:{upstream_port}\r\n"
                            f"Proxy-Authorization: {auth_val}\r\n\r\n"
                        ).encode("ascii")
                    )
                    await writer.drain()
                    established = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5.0)
                    self.assertTrue(established.startswith(b"HTTP/1.1 200"))

                    writer.write(b"PING")
                    await writer.drain()
                    pong = await asyncio.wait_for(reader.read(16), timeout=5.0)
                    self.assertEqual(pong, b"PONG")
                finally:
                    writer.close()
                    await writer.wait_closed()

            snap = self.service.status_snapshot()
            self.assertGreater(snap["bytes_up"], 0)
            self.assertGreater(snap["bytes_down"], 0)
        finally:
            upstream.close()
            await upstream.wait_closed()


if __name__ == "__main__":
    unittest.main()
