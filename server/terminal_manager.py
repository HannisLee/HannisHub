"""网页终端组件：在 Hub 进程内管理常驻 PTY shell 会话。

- 会话与浏览器连接解耦：WebSocket 断开不结束 shell，重新连接时回放输出缓冲。
- 多个连接可同时接入同一会话，输出同步广播，任意连接都能输入。
- 生命周期：键盘输入、调整尺寸、新连接接入视为“操作”；超过空闲时限无操作即释放。
- 会话只保存在内存，Hub 重启时全部结束。
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import signal
import struct
import subprocess
import termios
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException, WebSocket

# 模块位于子目录，ROOT_DIR 指向项目根目录
ROOT_DIR = Path(__file__).resolve().parent.parent
SETTINGS_PATH = ROOT_DIR / "settings.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "admins": None,  # None 表示最早创建的用户
    "idle_timeout_hours": 6,
    "max_sessions": 10,
    "shell": None,  # None 表示使用 $SHELL，回退 /bin/bash
    "scrollback_kb": 512,
}
REAPER_INTERVAL_SECONDS = 60
READ_CHUNK = 65536
MAX_TITLE_CHARS = 40
CLOSE_RELEASED = 4000
CLOSE_NOT_FOUND = 4404


def load_config() -> dict[str, Any]:
    """读取根 settings.json 中的 terminal 段，缺失字段使用默认值。"""
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    section = data.get("terminal") if isinstance(data, dict) else None
    config = dict(DEFAULT_CONFIG)
    if isinstance(section, dict):
        config.update({key: value for key, value in section.items() if key in DEFAULT_CONFIG})
    # 允许环境变量覆盖空闲时限，便于临时实例测试回收
    override = os.environ.get("HANNISHUB_TERMINAL_IDLE_SECONDS")
    if override:
        try:
            config["idle_timeout_hours"] = float(override) / 3600
        except ValueError:
            pass
    return config


def idle_timeout_seconds() -> float:
    try:
        return max(1.0, float(load_config()["idle_timeout_hours"]) * 3600)
    except (TypeError, ValueError):
        return float(DEFAULT_CONFIG["idle_timeout_hours"]) * 3600


def _shell_command() -> list[str]:
    configured = load_config().get("shell")
    shell = str(Path(str(configured)).expanduser()) if configured else os.environ.get("SHELL") or "/bin/bash"
    if not os.access(shell, os.X_OK):
        shell = "/bin/bash"
    return [shell, "-l"]


class TerminalSession:
    """一个 PTY shell 会话及其所有接入的 WebSocket 连接。"""

    def __init__(self, title: str, owner: str):
        self.id = uuid.uuid4().hex[:12]
        self.title = title
        self.owner = owner
        self.created_at = time.time()
        self.last_active = self.created_at
        self.cols = 120
        self.rows = 32
        # 每个连接一个发送队列，保证输出按顺序送达；None 表示结束
        self.clients: dict[WebSocket, asyncio.Queue[bytes | str | None]] = {}
        self.scrollback = bytearray()
        self.scrollback_limit = max(64, int(load_config().get("scrollback_kb") or 512)) * 1024
        self.closed = False
        self._loop = asyncio.get_running_loop()

        master_fd, slave_fd = os.openpty()
        self._set_winsize(slave_fd, self.rows, self.cols)
        env = dict(os.environ)
        env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "HANNISHUB_TERMINAL": self.id})
        try:
            self.process = subprocess.Popen(
                _shell_command(),
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=str(Path.home()),
                env=env,
                start_new_session=True,
                close_fds=True,
            )
        except Exception:
            os.close(master_fd)
            os.close(slave_fd)
            raise
        os.close(slave_fd)
        self.master_fd = master_fd
        os.set_blocking(master_fd, False)
        self._loop.add_reader(master_fd, self._on_readable)

    @staticmethod
    def _set_winsize(fd: int, rows: int, cols: int) -> None:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def touch(self) -> None:
        self.last_active = time.time()

    def info(self) -> dict[str, Any]:
        timeout = idle_timeout_seconds()
        return {
            "id": self.id,
            "title": self.title,
            "pid": self.process.pid,
            "created_at": self.created_at,
            "last_active": self.last_active,
            "expires_in": max(0, int(self.last_active + timeout - time.time())),
            "clients": len(self.clients),
        }

    # ---------- 输出 ----------

    def _on_readable(self) -> None:
        try:
            data = os.read(self.master_fd, READ_CHUNK)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            # shell 已退出（EIO / EOF）
            self._loop.create_task(manager.close(self.id, reason="exit"))
            return
        self.scrollback += data
        overflow = len(self.scrollback) - self.scrollback_limit
        if overflow > 0:
            del self.scrollback[:overflow]
        for queue in self.clients.values():
            # 连接长时间读不动时断开它，避免积压无限增长；浏览器会自动重连并回放
            if queue.qsize() > 4096:
                queue.put_nowait(None)
                continue
            queue.put_nowait(data)

    # ---------- 输入 ----------

    def write(self, data: str) -> None:
        if self.closed:
            return
        payload = data.encode("utf-8", errors="replace")
        self.touch()
        while payload:
            try:
                written = os.write(self.master_fd, payload)
            except BlockingIOError:
                # PTY 输入缓冲已满时短暂让出；正常键盘输入不会走到这里
                time.sleep(0.005)
                continue
            except OSError:
                return
            payload = payload[written:]

    def resize(self, cols: int, rows: int) -> None:
        if self.closed:
            return
        cols = min(max(int(cols), 10), 1000)
        rows = min(max(int(rows), 4), 500)
        self.touch()
        if (cols, rows) == (self.cols, self.rows):
            return
        self.cols, self.rows = cols, rows
        try:
            self._set_winsize(self.master_fd, rows, cols)
        except OSError:
            pass

    # ---------- 释放 ----------

    async def terminate(self, reason: str) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self._loop.remove_reader(self.master_fd)
        except Exception:
            pass
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
            for _ in range(30):
                if self.process.poll() is not None:
                    break
                await asyncio.sleep(0.1)
            if self.process.poll() is None:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.close(self.master_fd)
        except OSError:
            pass
        message = json.dumps({"type": reason}, ensure_ascii=False)
        for queue in self.clients.values():
            queue.put_nowait(message)
            queue.put_nowait(None)


class TerminalManager:
    """内存中的终端会话表与空闲回收。"""

    def __init__(self) -> None:
        self.sessions: dict[str, TerminalSession] = {}
        self._counter = 0

    def list(self) -> list[dict[str, Any]]:
        return [session.info() for session in sorted(self.sessions.values(), key=lambda item: item.created_at)]

    def get(self, session_id: str) -> TerminalSession:
        session = self.sessions.get(session_id)
        if not session or session.closed:
            raise HTTPException(status_code=404, detail="终端不存在或已释放")
        return session

    def create(self, owner: str, title: str | None = None) -> dict[str, Any]:
        limit = int(load_config().get("max_sessions") or 10)
        if len(self.sessions) >= limit:
            raise HTTPException(status_code=409, detail=f"最多同时保留 {limit} 个终端，请先关闭不用的终端")
        self._counter += 1
        name = _clean_title(title) or f"终端 {self._counter}"
        try:
            session = TerminalSession(name, owner)
        except OSError as error:
            raise HTTPException(status_code=500, detail=f"无法启动 shell：{error}") from error
        self.sessions[session.id] = session
        return session.info()

    def rename(self, session_id: str, title: Any) -> dict[str, Any]:
        session = self.get(session_id)
        name = _clean_title(title)
        if not name:
            raise HTTPException(status_code=400, detail="名称不能为空")
        session.title = name
        return session.info()

    async def close(self, session_id: str, reason: str = "closed") -> bool:
        session = self.sessions.pop(session_id, None)
        if not session:
            return False
        await session.terminate(reason)
        return True

    async def reap_idle(self) -> int:
        timeout = idle_timeout_seconds()
        now = time.time()
        expired = [sid for sid, session in self.sessions.items() if now - session.last_active > timeout]
        for session_id in expired:
            await self.close(session_id, reason="released")
        return len(expired)

    async def reaper_loop(self) -> None:
        interval = REAPER_INTERVAL_SECONDS
        if os.environ.get("HANNISHUB_TERMINAL_IDLE_SECONDS"):
            interval = 1
        while True:
            await asyncio.sleep(interval)
            try:
                await self.reap_idle()
            except Exception:
                pass

    async def shutdown_all(self) -> None:
        for session_id in list(self.sessions):
            await self.close(session_id, reason="released")

    async def attach(self, session_id: str, websocket: WebSocket) -> None:
        """接入一个 WebSocket：回放缓冲，然后循环处理输入，断开时只移除连接。"""
        session = self.sessions.get(session_id)
        if not session or session.closed:
            await websocket.close(code=CLOSE_NOT_FOUND, reason="not_found")
            return
        await websocket.accept()
        session.touch()
        queue: asyncio.Queue[bytes | str | None] = asyncio.Queue()
        if session.scrollback:
            queue.put_nowait(bytes(session.scrollback))
        session.clients[websocket] = queue

        async def sender() -> None:
            while True:
                item = await queue.get()
                if item is None:
                    await websocket.close(code=CLOSE_RELEASED)
                    return
                if isinstance(item, bytes):
                    # 合并积压的输出，减少帧数
                    chunks = [item]
                    while not queue.empty() and isinstance(queue._queue[0], bytes):  # type: ignore[attr-defined]
                        chunks.append(queue.get_nowait())  # type: ignore[arg-type]
                    await websocket.send_bytes(b"".join(chunks))
                else:
                    await websocket.send_text(item)

        send_task = asyncio.create_task(sender())
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(message, dict):
                    continue
                kind = message.get("type")
                if kind == "input" and isinstance(message.get("data"), str):
                    session.write(message["data"])
                elif kind == "resize":
                    try:
                        session.resize(int(message.get("cols")), int(message.get("rows")))
                    except (TypeError, ValueError):
                        continue
        except Exception:
            pass
        finally:
            session.clients.pop(websocket, None)
            send_task.cancel()


def _clean_title(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:MAX_TITLE_CHARS]


manager = TerminalManager()
