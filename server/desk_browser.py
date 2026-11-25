"""按登录账号管理工位 Chrome 的容器、持久卷和空闲回收。"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import tempfile
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import HTTPException

from core.auth import account_created_at, get_auth_config, get_settings_section
from core.database import db_path
from server.desk_browser_bridge import DISPLAY_PORT, PROXY_PORT, STATUS_PATH

PREFIX = "/desk-browser/session/"
STREAM_PATH = PREFIX + "api/websockets"
IMAGE = "lscr.io/linuxserver/chrome@sha256:e1fd857c81d4443448d61e32bfe26cd5d731487cdeb82c025ea3c0ba73b0523c"
LABEL = "hannishub.desk-browser"
BRIDGE = Path(__file__).with_name("desk_browser_bridge.py")
CONTAINER_BRIDGE = "/desk-browser-bridge.py"
PYTHON = "/lsiopy/bin/python3"
LOG = logging.getLogger(__name__)


@dataclass
class Instance:
    port: int
    used_at: float
    clients: int = 0


def profile_id(owner: str) -> str | None:
    created_at = account_created_at(owner)
    if created_at is None:
        return None
    return hashlib.sha256(f"{created_at}\x00{owner}".encode()).hexdigest()[:32]


def _token(profile: str) -> str:
    secret = str(get_auth_config()["session_secret"]).encode()
    return hmac.new(secret, f"desk-browser:{profile}".encode(), "sha256").hexdigest()


def _label() -> str:
    namespace = hashlib.sha256(str(db_path().resolve()).encode()).hexdigest()[:16]
    return f"{LABEL}={namespace}"


def _config() -> tuple[int, int]:
    settings = get_settings_section("desk_browser")
    settings = settings if isinstance(settings, dict) else {}
    limit = settings.get("max_active", 6)
    idle = settings.get("idle_minutes", 30)
    return (
        limit if type(limit) is int and 1 <= limit <= 6 else 6,
        idle if type(idle) is int and 1 <= idle <= 1440 else 30,
    )


def assets_dir() -> Path:
    return db_path().resolve().parent / "desk-browser-client" / IMAGE.rsplit(":", 1)[1]


class DockerError(RuntimeError):
    pass


async def _command(*args: str, env: dict[str, str] | None = None, missing: bool = False) -> str:
    try:
        process = await asyncio.create_subprocess_exec(
            *args, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except OSError as error:
        raise DockerError(f"无法运行 {args[0]}") from error
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 75)
    except (TimeoutError, asyncio.CancelledError):
        with suppress(ProcessLookupError):
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        error = stderr.decode(errors="replace").strip()
        if missing and any(message in error for message in ("No such container", "no such volume", "No such object")):
            return ""
        raise DockerError(error or f"{args[0]} 执行失败")
    return stdout.decode().strip()


def _names(profile: str) -> tuple[str, str, str]:
    return f"hh-desk-browser-{profile}", f"hh-desk-gw-{profile}", f"hh-desk-sock-{profile}"


async def _ensure_assets() -> None:
    target = assets_dir()
    if (target / "index.html").is_file():
        return
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 从未启动过的固定镜像取客户端，任何用户的容器都不参与提供网页脚本。
    container = await _command("docker", "create", "--network", "none", IMAGE)
    try:
        with tempfile.TemporaryDirectory(dir=target.parent) as work:
            stage = Path(work) / "client"
            await _command("docker", "cp", f"{container}:/usr/share/selkies/selkies-dashboard", str(stage))
            if not (stage / "index.html").is_file():
                raise DockerError("镜像中的浏览器客户端不完整")
            stage.rename(target)
    finally:
        await _command("docker", "rm", "-v", container, missing=True)


class DeskBrowsers:
    def __init__(self):
        self._lock = asyncio.Lock()
        self._instances: dict[str, Instance] = {}
        self._revoked: dict[str, float] = {}

    def bind_session(self, session: dict) -> None:
        if not session.get("desk_browser_session"):
            session["desk_browser_session"] = secrets.token_hex(16)

    def session_allowed(self, session: dict) -> bool:
        identity = session.get("desk_browser_session")
        return isinstance(identity, str) and identity not in self._revoked

    def revoke_session(self, session: dict) -> None:
        identity = session.get("desk_browser_session")
        if isinstance(identity, str):
            max_age = int(get_auth_config()["session_max_age_seconds"])
            self._revoked[identity] = time.monotonic() + max_age

    async def _restore(self) -> None:
        result = await _command("docker", "ps", "-a", "--filter", f"label={_label()}", "--format", "{{.Names}}")
        for name in result.splitlines():
            match = re.fullmatch(r"hh-desk-gw-([a-f0-9]{32})", name)
            if not match or match[1] in self._instances:
                continue
            profile = match[1]
            port = await self._port(name)
            if port:
                self._instances[profile] = Instance(port, time.monotonic())
            else:
                await self._stop(profile)

    async def _port(self, gateway: str) -> int | None:
        data = await _command("docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", gateway, missing=True)
        bindings = (json.loads(data or "null") or {}).get(f"{DISPLAY_PORT}/tcp") or []
        if len(bindings) == 1 and bindings[0]["HostIp"] == "127.0.0.1":
            return int(bindings[0]["HostPort"])
        return None

    async def _stop(self, profile: str) -> None:
        browser, gateway, sockets = _names(profile)
        await _command("docker", "stop", "-t", "8", browser, missing=True)
        await _command("docker", "rm", "-f", browser, missing=True)
        await _command("docker", "rm", "-f", gateway, missing=True)
        await _command("docker", "volume", "rm", sockets, missing=True)
        self._instances.pop(profile, None)

    async def _healthy(self, profile: str, port: int) -> bool:
        try:
            async with httpx.AsyncClient(timeout=1, trust_env=False) as client:
                response = await client.get(
                    f"http://127.0.0.1:{port}{STATUS_PATH.decode()}",
                    headers={"X-HannisHub-Browser": _token(profile)},
                )
                return response.is_success
        except httpx.HTTPError:
            return False

    async def _start(self, profile: str) -> Instance:
        browser, gateway, sockets = _names(profile)
        await self._stop(profile)
        socket_mount = f"{sockets}:/desk-browser"
        script_mount = f"type=bind,src={BRIDGE},dst={CONTAINER_BRIDGE},readonly"
        interfaces = json.loads(await _command("ip", "-j", "-4", "address", "show"))
        blocked = " ".join(address["local"] for iface in interfaces for address in iface.get("addr_info", []))
        await _command(
            "docker", "run", "-d", "--name", gateway, "--label", _label(),
            "--publish", f"127.0.0.1::{DISPLAY_PORT}", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--read-only", "--memory", "128m", "--pids-limit", "64",
            "--mount", script_mount, "--volume", socket_mount,
            "-e", "HANNISHUB_BROWSER_TOKEN", "-e", "HANNISHUB_BROWSER_BLOCK_IPS",
            "--entrypoint", PYTHON, IMAGE, "-I", CONTAINER_BRIDGE, "gateway",
            env={**os.environ, "HANNISHUB_BROWSER_TOKEN": _token(profile), "HANNISHUB_BROWSER_BLOCK_IPS": blocked},
        )
        await _command(
            "docker", "run", "-d", "--name", browser, "--label", _label(), "--network", "none",
            "--cap-drop", "NET_RAW", "--security-opt", "no-new-privileges",
            "--memory", "1536m", "--cpus", "2", "--pids-limit", "768", "--shm-size", "384m",
            "--mount", script_mount, "--volume", socket_mount, "--volume", f"{browser}:/config",
            "-e", f"SUBFOLDER={PREFIX}",
            "-e", f"CHROME_CLI=--proxy-server=socks5://127.0.0.1:{PROXY_PORT} --proxy-bypass-list=<-loopback> about:blank",
            "-e", "DISABLE_SUDO=true", "-e", "DISABLE_TERMINALS=true", "-e", "DISABLE_OPEN_TOOLS=true",
            "-e", "SELKIES_ENABLE_SHARING=false|locked", "-e", "SELKIES_ENABLE_SHARED=false|locked",
            "-e", "SELKIES_FILE_TRANSFERS=none", "-e", "SELKIES_PRINTING_ENABLED=false",
            "-e", "SELKIES_UI_SIDEBAR_SHOW_APPS=false|locked", "-e", "SELKIES_UI_SIDEBAR_SHOW_FILES=false|locked",
            "-e", "SELKIES_COMMAND_ENABLED=false", "-e", "SELKIES_MICROPHONE_ENABLED=false|locked",
            "-e", "SELKIES_WEBCAM_ENABLED=false|locked", IMAGE,
        )
        await _command("docker", "exec", "-d", browser, PYTHON, "-I", CONTAINER_BRIDGE, "browser")
        port = await self._port(gateway)
        if not port:
            raise DockerError("浏览器网关没有本地端口")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if await self._healthy(profile, port):
                return Instance(port, time.monotonic())
            await asyncio.sleep(0.4)
        raise DockerError("等待工位浏览器就绪超时")

    async def start(self, owner: str) -> str:
        profile = profile_id(owner)
        if profile is None:
            raise HTTPException(401, "会话已失效")
        async with self._lock:
            try:
                await _ensure_assets()
                await self._restore()
                existing = self._instances.get(profile)
                if existing and await self._healthy(profile, existing.port):
                    existing.used_at = time.monotonic()
                    return profile
                limit, _ = _config()
                if not existing and len(self._instances) >= limit:
                    raise HTTPException(503, "工位浏览器暂时满员，请稍后重试")
                try:
                    self._instances[profile] = await self._start(profile)
                except (DockerError, TimeoutError, asyncio.CancelledError):
                    with suppress(DockerError, TimeoutError):
                        await self._stop(profile)
                    raise
                return profile
            except (DockerError, OSError, ValueError, TimeoutError) as error:
                LOG.error("启动工位浏览器失败：%s", error)
                raise HTTPException(503, "工位浏览器暂时无法启动，请稍后重试") from error

    @asynccontextmanager
    async def connection(self, owner: str):
        profile = profile_id(owner)
        async with self._lock:
            instance = self._instances.get(profile)
            if instance:
                instance.clients += 1
        try:
            if profile is None or not instance:
                yield None
            else:
                yield (
                    f"ws://127.0.0.1:{instance.port}{STREAM_PATH}",
                    {"X-HannisHub-Browser": _token(profile)},
                )
        finally:
            if instance:
                instance.clients -= 1
                instance.used_at = time.monotonic()

    async def purge(self, profile: str) -> None:
        async with self._lock:
            await self._stop(profile)
            browser, _, _ = _names(profile)
            await _command("docker", "volume", "rm", browser, missing=True)

    async def reap(self) -> None:
        while True:
            try:
                async with self._lock:
                    await self._restore()
                    _, idle = _config()
                    now = time.monotonic()
                    self._revoked = {identity: expires for identity, expires in self._revoked.items() if expires > now}
                    cutoff = now - idle * 60
                    for profile, instance in list(self._instances.items()):
                        if not instance.clients and instance.used_at < cutoff:
                            await self._stop(profile)
            except (DockerError, OSError, ValueError, TimeoutError) as error:
                LOG.warning("检查工位浏览器失败：%s", error)
            await asyncio.sleep(60)


browsers = DeskBrowsers()
