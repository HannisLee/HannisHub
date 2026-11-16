"""真实独立后台与隔离 Hub：重启后 PTY 保留及代理权限验证。"""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class TerminalRestartTest(unittest.TestCase):
    def test_restart_and_security(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            hub_port, backend_port = free_port(), free_port()
            env = dict(os.environ, HANNISHUB_TEST_EXTERNAL_TERMINAL="1", HANNISHUB_DB_PATH=str(work / "test.db"), HANNISHUB_TERMINAL_SETTINGS_PATH=str(work / "settings.json"))
            # 初始化和所有测试进程仅使用临时配置。
            subprocess.run([sys.executable, "-c", "from core import auth; from pathlib import Path; import os; auth.SETTINGS_PATH=Path(os.environ['HANNISHUB_TERMINAL_SETTINGS_PATH']); auth.configure_admin('lihan','e2e-test-pass-123'); auth.create_user('guest','e2e-test-pass-123')"], cwd=ROOT, env=env, check=True)
            config = json.loads((work / "settings.json").read_text())
            config["terminal"] = {"backend_port": backend_port}
            (work / "settings.json").write_text(json.dumps(config))
            processes = []
            def start(args):
                process = subprocess.Popen([sys.executable, *args], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                processes.append(process)
                return process
            def wait_ready(url, expected):
                for _ in range(150):
                    try:
                        if httpx.get(url, timeout=1).status_code == expected:
                            return
                    except httpx.HTTPError:
                        pass
                    time.sleep(.1)
                self.fail("测试服务未就绪")
            def hub_start():
                process = start(["scripts/e2e/launch_test_hub.py", str(work), str(hub_port)])
                wait_ready(f"http://127.0.0.1:{hub_port}/api/auth/status", 200)
                return process
            try:
                start(["-m", "server.terminal_service"])
                wait_ready(f"http://127.0.0.1:{backend_port}/internal/health", 403)
                hub = hub_start()
                origin = f"http://127.0.0.1:{hub_port}"
                with httpx.Client(base_url=origin, headers={"Origin": origin}) as client:
                    self.assertEqual(client.get("/api/terminal/sessions").status_code, 401)
                    self.assertEqual(client.post("/api/auth/login", json={"username": "guest", "password": "e2e-test-pass-123"}).status_code, 200)
                    self.assertEqual(client.get("/api/terminal/sessions").status_code, 403)
                    client.post("/api/auth/login", json={"username": "lihan", "password": "e2e-test-pass-123"}).raise_for_status()
                    self.assertEqual(client.post("/api/terminal/sessions", json={}, headers={"Origin": "http://evil.invalid"}).status_code, 403)
                    info = client.post("/api/terminal/sessions", json={}).json()["session"]
                    sid = info["id"]
                    cookie = "; ".join(f"{k}={v}" for k, v in client.cookies.items())
                    url = f"ws://127.0.0.1:{hub_port}/api/terminal/sessions/{sid}/ws"
                    async def write_and_read(command, marker):
                        async with connect(url, origin=origin, additional_headers={"Cookie": cookie}) as ws:
                            await ws.send(json.dumps({"type": "input", "data": command + "\n"}))
                            output = b""
                            async with asyncio.timeout(10):
                                while marker not in output:
                                    message = await ws.recv()
                                    if isinstance(message, bytes):
                                        output += message
                            return output
                    asyncio.run(write_and_read("export RESTART_PROOF=survived; (sleep 2; printf 'TASK_%s\\n' continued) & printf 'BEFORE_%s' restart", b"BEFORE_restart"))
                    async def stop_connected_hub():
                        async with connect(url, origin=origin, additional_headers={"Cookie": cookie}) as ws:
                            await ws.recv()
                            hub.terminate()
                            with self.assertRaises(ConnectionClosed):
                                async with asyncio.timeout(10):
                                    while True:
                                        await ws.recv()
                    asyncio.run(stop_connected_hub())
                    hub.wait(timeout=15)
                    # Hub 停止期间，后台进程和 shell 均仍然存在。
                    os.kill(info["pid"], 0)
                    time.sleep(3)
                    hub = hub_start()
                    restored = client.get("/api/terminal/sessions").json()["sessions"]
                    self.assertEqual([(s["id"], s["pid"]) for s in restored], [(sid, info["pid"])])
                    output = asyncio.run(write_and_read("printf 'AFTER_%s' \"$RESTART_PROOF\"", b"AFTER_survived"))
                    self.assertIn(b"TASK_continued", output)
                    client.patch(f"/api/terminal/sessions/{sid}", json={"title": "重启保留"}).raise_for_status()
                    self.assertEqual(client.get("/api/terminal/sessions").json()["sessions"][0]["title"], "重启保留")
                    async def missing_session():
                        async with connect(url.replace(sid, "missing"), origin=origin, additional_headers={"Cookie": cookie}) as ws:
                            with self.assertRaises(ConnectionClosed) as ctx:
                                await ws.recv()
                            self.assertEqual(ctx.exception.rcvd.code, 4404)
                    asyncio.run(missing_session())
                    client.delete(f"/api/terminal/sessions/{sid}").raise_for_status()
                    self.assertEqual(client.get("/api/terminal/sessions").json()["sessions"], [])
                    self.assertEqual(httpx.get(f"http://127.0.0.1:{backend_port}/internal/health", headers={"Authorization": "Bearer wrong"}).status_code, 403)
                    group = client.post("/api/terminal/commands", json={"name": "测试命令", "commands": ["printf 'GROUP_%s' ok"]}).json()["command"]
                    result = client.post(f"/api/terminal/commands/{group['id']}/run").json()["session"]
                    sid = result["id"]
                    url = f"ws://127.0.0.1:{hub_port}/api/terminal/sessions/{sid}/ws"
                    asyncio.run(write_and_read("printf 'RUN_%s' ok", b"GROUP_ok"))
                    client.delete(f"/api/terminal/sessions/{sid}").raise_for_status()
                    processes[0].terminate()
                    processes[0].wait(timeout=15)
                    self.assertEqual(client.get("/api/terminal/sessions").status_code, 503)

            finally:
                for process in reversed(processes):
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=15)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
