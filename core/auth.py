"""HannisHub 的登录、会话与权限中间件。"""

import json
import hashlib
import os
import secrets
import threading
import time
from copy import deepcopy
from collections import defaultdict, deque
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from fastapi.responses import JSONResponse, RedirectResponse
from pwdlib import PasswordHash

# 模块位于子目录，ROOT_DIR 指向项目根目录
ROOT_DIR = Path(__file__).resolve().parent.parent
SETTINGS_PATH = ROOT_DIR / "settings.json"
DEFAULT_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
LEGACY_DEFAULT_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60
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
_DUMMY_HASH = _PASSWORD_HASHER.hash(secrets.token_urlsafe(16))
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
            configured_max_age = auth.get("session_max_age_seconds", DEFAULT_SESSION_MAX_AGE_SECONDS)
            max_age = int(configured_max_age)
            if max_age == LEGACY_DEFAULT_SESSION_MAX_AGE_SECONDS:
                max_age = DEFAULT_SESSION_MAX_AGE_SECONDS
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


# ---------- 多用户 ----------
# auth.users 为用户列表：{username, password_hash, created_at, session_version}。
# session_version 在重置密码时递增，使该用户已有会话失效。

USERNAME_MIN_CHARS = 3
USERNAME_MAX_CHARS = 64
PASSWORD_MIN_CHARS = 8
MAX_USERS = 100

# 中间件每个请求都要校验会话，按 settings.json 修改时间缓存用户表
_users_cache: tuple[float, dict[str, dict[str, Any]]] | None = None


def _users_unlocked(auth: dict[str, Any]) -> list[dict[str, Any]]:
    """返回 auth.users，并把旧版单管理员字段迁移为第一个用户。"""
    users = auth.get("users")
    if not isinstance(users, list):
        users = []
        auth["users"] = users
    legacy_name = str(auth.get("username") or "")
    legacy_hash = str(auth.get("password_hash") or "")
    if legacy_name and legacy_hash:
        if not any(user.get("username") == legacy_name for user in users):
            users.insert(0, {
                "username": legacy_name,
                "password_hash": legacy_hash,
                "created_at": time.time(),
                "session_version": 1,
            })
        auth.pop("username", None)
        auth.pop("password_hash", None)
    return users


def migrate_legacy_admin() -> None:
    """启动时把旧版单管理员配置迁移到用户列表。"""
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        auth = data["auth"]
        if auth.get("username") or not isinstance(auth.get("users"), list):
            _users_unlocked(auth)
            _write_settings_unlocked(data)


def _user_map() -> dict[str, dict[str, Any]]:
    """读取用户名到用户记录的映射（带修改时间缓存）。"""
    global _users_cache
    try:
        mtime = SETTINGS_PATH.stat().st_mtime
    except OSError:
        mtime = -1.0
    if _users_cache and _users_cache[0] == mtime:
        return _users_cache[1]
    with _SETTINGS_LOCK:
        auth = dict(get_auth_config())
        users = _users_unlocked(auth)
    mapping = {str(user.get("username")): user for user in users if user.get("username") and user.get("password_hash")}
    _users_cache = (mtime, mapping)
    return mapping


def validate_username(username: str) -> str:
    username = username.strip()
    if not (USERNAME_MIN_CHARS <= len(username) <= USERNAME_MAX_CHARS) or any(char.isspace() for char in username):
        raise ValueError(f"用户名需为 {USERNAME_MIN_CHARS}-{USERNAME_MAX_CHARS} 位，且不能包含空白字符")
    return username


def validate_password(password: str) -> str:
    if len(password) < PASSWORD_MIN_CHARS:
        raise ValueError(f"密码至少需要 {PASSWORD_MIN_CHARS} 位")
    return password


def is_configured() -> bool:
    """判断是否已经创建至少一个用户。"""
    return bool(_user_map())


def configure_admin(username: str, password: str) -> None:
    """首次启动时创建第一个用户，只允许在没有任何用户时调用。"""
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        users = _users_unlocked(data["auth"])
        if users:
            raise RuntimeError("管理员已经初始化")
        users.append({
            "username": username,
            "password_hash": _PASSWORD_HASHER.hash(password),
            "created_at": time.time(),
            "session_version": 1,
        })
        _write_settings_unlocked(data)


def authenticate(username: str, password: str) -> bool:
    """校验用户名与密码。"""
    user = _user_map().get(username)
    if not user:
        # 对不存在的用户也做一次哈希计算，避免通过响应时间探测用户名
        _PASSWORD_HASHER.verify(password, _DUMMY_HASH)
        return False
    return _PASSWORD_HASHER.verify(password, str(user["password_hash"]))


def session_version(username: str) -> int | None:
    """返回用户当前会话版本；用户不存在时返回 None。"""
    user = _user_map().get(username)
    return int(user.get("session_version") or 1) if user else None


def list_users() -> list[dict[str, Any]]:
    """返回用户公开信息，不含密码哈希。"""
    return [
        {"username": name, "created_at": user.get("created_at", 0)}
        for name, user in _user_map().items()
    ]


def create_user(username: str, password: str) -> dict[str, Any]:
    """新增用户。"""
    username = validate_username(username)
    validate_password(password)
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        users = _users_unlocked(data["auth"])
        if any(user.get("username") == username for user in users):
            raise ValueError("用户名已存在")
        if len(users) >= MAX_USERS:
            raise ValueError(f"用户数量已达上限 {MAX_USERS}")
        user = {
            "username": username,
            "password_hash": _PASSWORD_HASHER.hash(password),
            "created_at": time.time(),
            "session_version": 1,
        }
        users.append(user)
        _write_settings_unlocked(data)
    return {"username": username, "created_at": user["created_at"]}


def set_user_password(username: str, new_password: str) -> None:
    """重置指定用户密码，并使其已有会话失效。"""
    validate_password(new_password)
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        for user in _users_unlocked(data["auth"]):
            if user.get("username") == username:
                user["password_hash"] = _PASSWORD_HASHER.hash(new_password)
                user["session_version"] = int(user.get("session_version") or 1) + 1
                _write_settings_unlocked(data)
                return
    raise LookupError("用户不存在")


def delete_user(username: str, operator: str) -> None:
    """删除用户；不能删除自己，也不能删除最后一个用户。"""
    if username == operator:
        raise ValueError("不能删除当前登录的账号")
    with _SETTINGS_LOCK:
        data = ensure_auth_settings()
        users = _users_unlocked(data["auth"])
        remaining = [user for user in users if user.get("username") != username]
        if len(remaining) == len(users):
            raise LookupError("用户不存在")
        if not remaining:
            raise ValueError("至少需要保留一个用户")
        data["auth"]["users"] = remaining
        _write_settings_unlocked(data)


def change_password(username: str, current_password: str, new_password: str) -> None:
    """当前用户修改自己的密码。"""
    if not authenticate(username, current_password):
        raise ValueError("当前密码不正确")
    set_user_password(username, new_password)


def login_session(session: dict[str, Any], username: str) -> None:
    """写入登录会话，记录用户名与会话版本。"""
    session.clear()
    session["user"] = username
    session["ver"] = session_version(username) or 1


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


# 唯一管理员账号；旧版共享数据迁移进数据库时归属该账号
ADMIN_USERNAME = "lihan"


def is_terminal_admin(username: str | None) -> bool:
    """网页终端仅对 lihan 管理员开放。"""
    return username == ADMIN_USERNAME and username in _user_map()


def current_username(session: dict[str, Any]) -> str | None:
    """从会话中读取当前用户名；用户已删除或密码已重置时会话失效。"""
    value = session.get("user")
    if not value:
        return None
    version = session_version(str(value))
    if version is None or int(session.get("ver") or 1) != version:
        return None
    return str(value)


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


def login_account_key(username: str) -> str:
    """限制账号维度的猜密，不在内存中保留明文账号。"""
    return "account:" + hashlib.sha256(username.encode("utf-8")).hexdigest()


def record_login_failure(identifier: str) -> None:
    """记录一次登录失败，用于简单防暴力破解。"""
    now = time.monotonic()
    with _LOGIN_FAILURES_LOCK:
        # 清除过期条目并限制不同来源占用的内存。
        if len(_LOGIN_FAILURES) >= 10000:
            for key in list(_LOGIN_FAILURES):
                if not _LOGIN_FAILURES[key] or now - _LOGIN_FAILURES[key][-1] >= LOGIN_FAILURE_WINDOW_SECONDS:
                    del _LOGIN_FAILURES[key]
            if len(_LOGIN_FAILURES) >= 10000 and identifier not in _LOGIN_FAILURES:
                return
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


# 普通账号可连接的 WebSocket 路径
REGULAR_WEBSOCKET_PATHS = {"/api/chat-lobby/ws"}
# 普通账号登录后的默认页面，也是访问受限页面时的跳转目标
REGULAR_HOME = "/chat-lobby"


def _regular_user_allowed(path: str, method: str) -> bool:
    """普通账号默认拒绝管理接口，只放行页面所需接口。"""
    if path in {"/chat", "/chat/", "/chat-lobby", "/chat-lobby/", "/llama/asr", "/llama/asr/", "/llama/ocr", "/llama/ocr/"}:
        return method in {"GET", "HEAD"}
    # 聊天大厅的场景素材（布局、图集、形象部件）
    if path.startswith("/chat-lobby/"):
        return method in {"GET", "HEAD"}
    if path.startswith("/api/chat-lobby/"):
        return True
    if path.startswith("/emojibase/"):
        return method in {"GET", "HEAD"}
    if path in {"/api/auth/logout", "/api/auth/password"}:
        return method == "POST"
    if path == "/api/ai-settings":
        return method == "GET"
    if path == "/api/chat-room/messages" and method == "DELETE":
        return False
    if path.startswith(("/api/chat-room/", "/api/ocr/records/")) or path == "/api/ocr/records":
        return True
    if path == "/llama-manager/api/asr" or path.startswith("/llama-manager/api/asr/"):
        return True
    if path in {"/llama-manager/api/custom-services", "/llama-manager/api/managed-processes"}:
        return method == "GET"
    if path == "/llama-manager/api/start":
        return method == "POST"
    if path.startswith("/llama-manager/llama-process/") and path.endswith("/api/health"):
        return method == "GET"
    return False


def _same_origin(scope: dict[str, Any]) -> bool:
    """写请求必须携带与服务一致的 Origin 或 Referer。"""
    headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
    source = headers.get("origin") or headers.get("referer") or ""
    parsed = urlsplit(source)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        return False
    origin = f"{parsed.scheme}://{parsed.netloc}".lower()
    expected = f"{scope.get('scheme', 'http')}://{headers.get('host', '')}".lower()
    allowed = {item.strip().lower() for item in os.environ.get("HANNISHUB_DEV_ORIGINS", "").split(",") if item.strip()}
    return origin == expected or origin in allowed


class AuthMiddleware:
    """统一拦截未登录请求，保护 Hub 页面和所有挂载的子服务。"""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") == "websocket":
            # WebSocket 同样需要有效会话，未登录在握手阶段直接拒绝；普通账号只能连接聊天大厅同步通道
            username = current_username(scope.get("session") or {})
            if username == "lihan" or (username and scope.get("path") in REGULAR_WEBSOCKET_PATHS):
                await self.app(scope, receive, send)
            else:
                await send({"type": "websocket.close", "code": 4401})
            return
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if scope.get("method") not in {"GET", "HEAD", "OPTIONS"} and not _same_origin(scope):
            await JSONResponse({"detail": "请求来源不受信任"}, status_code=403)(scope, receive, send)
            return
        # 登录页的 Next.js 静态脚本和样式必须在未登录时可读取，
        # 它们不包含业务数据，实际 API 与页面导航仍由下方会话判断保护。
        if path in PUBLIC_PATHS or path.startswith("/_next/"):
            await self.app(scope, receive, send)
            return

        session = scope.get("session") or {}
        username = current_username(session)
        if username:
            if username != "lihan" and not _regular_user_allowed(path, scope.get("method", "GET")):
                if _accepts_html(scope):
                    await RedirectResponse(url=REGULAR_HOME, status_code=303)(scope, receive, send)
                else:
                    await JSONResponse({"detail": "仅管理员可访问"}, status_code=403)(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return

        if _accepts_html(scope):
            next_path = quote(path, safe="/")
            response: Any = RedirectResponse(url=f"/login?next={next_path}", status_code=307)
        else:
            response = JSONResponse({"detail": "未登录或会话已过期"}, status_code=401)
        await response(scope, receive, send)
