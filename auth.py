"""HannisHub 的登录、会话与权限中间件。"""

import json
import os
import secrets
import threading
import time
from copy import deepcopy
from collections import defaultdict, deque
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi.responses import JSONResponse, RedirectResponse
from pwdlib import PasswordHash

ROOT_DIR = Path(__file__).resolve().parent
SETTINGS_PATH = ROOT_DIR / "settings.json"
DEFAULT_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60
PUBLIC_PATHS = {
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/setup",
    "/api/health",
    "/login",
    "/login/",
    "/favicon.ico",
    "/icon.png",
    "/icon.svg",
}

_SETTINGS_LOCK = threading.RLock()
_PASSWORD_HASHER = PasswordHash.recommended()
_LOGIN_FAILURES: dict[str, deque[float]] = defaultdict(deque)
_LOGIN_FAILURES_LOCK = threading.Lock()
MAX_LOGIN_FAILURES = 5
LOGIN_FAILURE_WINDOW_SECONDS = 5 * 60


def _read_settings_unlocked() -> dict[str, Any]:
    """读取根配置；文件不存在或损坏时返回空对象。"""
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _write_settings_unlocked(data: dict[str, Any]) -> None:
    """原子写入根配置，避免半写入导致登录配置损坏。"""
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = SETTINGS_PATH.with_suffix(".json.tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp_path, SETTINGS_PATH)


def ensure_auth_settings() -> dict[str, Any]:
    """确保登录配置存在，并自动生成会话签名密钥。"""
    with _SETTINGS_LOCK:
        data = _read_settings_unlocked()
        auth = data.setdefault("auth", {})
        if not isinstance(auth, dict):
            auth = {}
            data["auth"] = auth

        changed = False
        if not auth.get("session_secret"):
            auth["session_secret"] = secrets.token_urlsafe(48)
            changed = True
        try:
            max_age = int(auth.get("session_max_age_seconds", DEFAULT_SESSION_MAX_AGE_SECONDS))
        except (TypeError, ValueError):
            max_age = DEFAULT_SESSION_MAX_AGE_SECONDS
        if max_age <= 0:
            max_age = DEFAULT_SESSION_MAX_AGE_SECONDS
        if auth.get("session_max_age_seconds") != max_age:
            auth["session_max_age_seconds"] = max_age
            changed = True

        if changed:
            _write_settings_unlocked(data)
        return data


def get_auth_config() -> dict[str, Any]:
    """读取当前登录配置。"""
    return ensure_auth_settings().get("auth", {})


def is_configured() -> bool:
    """判断是否已经完成管理员初始化。"""
    auth = get_auth_config()
    return bool(auth.get("username") and auth.get("password_hash"))


def configure_admin(username: str, password: str) -> None:
    """初始化管理员账号，只允许在未配置时调用。"""
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        auth = data.setdefault("auth", {})
        if auth.get("username") and auth.get("password_hash"):
            raise RuntimeError("管理员已经初始化")
        auth["username"] = username
        auth["password_hash"] = _PASSWORD_HASHER.hash(password)
        _write_settings_unlocked(data)


def authenticate(username: str, password: str) -> bool:
    """校验管理员账号密码。"""
    auth = get_auth_config()
    stored_hash = str(auth.get("password_hash") or "")
    if not username or not stored_hash or username != str(auth.get("username") or ""):
        return False
    return _PASSWORD_HASHER.verify(password, stored_hash)


def change_password(current_password: str, new_password: str) -> None:
    """修改管理员密码。"""
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        auth = data.setdefault("auth", {})
        stored_hash = str(auth.get("password_hash") or "")
        if not stored_hash or not _PASSWORD_HASHER.verify(current_password, stored_hash):
            raise ValueError("当前密码不正确")
        auth["password_hash"] = _PASSWORD_HASHER.hash(new_password)
        _write_settings_unlocked(data)


def get_settings_section(name: str) -> Any:
    """线程安全地读取根 settings.json 的一个非认证配置区段。"""
    if name == "auth":
        raise ValueError("认证配置不能通过通用配置接口读取")
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        return deepcopy(data.get(name))


def update_settings_section(name: str, value: Any) -> None:
    """线程安全地写入根 settings.json 的一个非认证配置区段。"""
    if name == "auth":
        raise ValueError("认证配置不能通过通用配置接口修改")
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        data[name] = deepcopy(value)
        _write_settings_unlocked(data)


def current_username(session: dict[str, Any]) -> str | None:
    """从会话中读取当前用户名。"""
    value = session.get("user")
    return str(value) if value else None


def is_login_allowed(identifier: str) -> bool:
    """判断指定客户端是否仍允许尝试登录。"""
    now = time.monotonic()
    with _LOGIN_FAILURES_LOCK:
        attempts = _LOGIN_FAILURES.get(identifier)
        if not attempts:
            return True
        while attempts and now - attempts[0] >= LOGIN_FAILURE_WINDOW_SECONDS:
            attempts.popleft()
        return len(attempts) < MAX_LOGIN_FAILURES


def record_login_failure(identifier: str) -> None:
    """记录一次登录失败，用于简单防暴力破解。"""
    now = time.monotonic()
    with _LOGIN_FAILURES_LOCK:
        attempts = _LOGIN_FAILURES[identifier]
        attempts.append(now)
        while attempts and now - attempts[0] >= LOGIN_FAILURE_WINDOW_SECONDS:
            attempts.popleft()


def clear_login_failures(identifier: str) -> None:
    """登录成功后清除失败计数。"""
    with _LOGIN_FAILURES_LOCK:
        _LOGIN_FAILURES.pop(identifier, None)


def _accepts_html(scope: dict[str, Any]) -> bool:
    """判断请求是否来自普通浏览器页面导航。"""
    for key, value in scope.get("headers", []):
        if key == b"accept" and b"text/html" in value:
            return True
    return False


class AuthMiddleware:
    """统一拦截未登录请求，保护 Hub 页面和所有挂载的子服务。"""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        # 登录页的 Next.js 静态脚本和样式必须在未登录时可读取，
        # 它们不包含业务数据，实际 API 与页面导航仍由下方会话判断保护。
        if path in PUBLIC_PATHS or path.startswith("/_next/"):
            await self.app(scope, receive, send)
            return

        session = scope.get("session") or {}
        if current_username(session):
            await self.app(scope, receive, send)
            return

        if _accepts_html(scope):
            next_path = quote(path, safe="/")
            response: Any = RedirectResponse(url=f"/login?next={next_path}", status_code=307)
        else:
            response = JSONResponse({"detail": "未登录或会话已过期"}, status_code=401)
        await response(scope, receive, send)
